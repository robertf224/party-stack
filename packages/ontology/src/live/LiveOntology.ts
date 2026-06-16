import { createBlobManager, createInMemoryBlobStore, type BlobStoreProvider } from "@party-stack/blobs";
import { BasicIndex, Collection, createCollection } from "@tanstack/db";
import { applyActionLogic } from "./applyActionLogic.js";
import { decorateObjectAttachmentSources } from "./attachmentSources.js";
import {
    createLiveOntologyAttachments,
    type LiveOntologyAttachments,
} from "./createLiveOntologyAttachments.js";
import { resolveActionParameters } from "./expression.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type { PreparedActionParameters } from "./prepareActionParameters.js";
import type { OntologyIR } from "../ir/index.js";
import type { attachment } from "../utils/values.js";

export type { LiveOntologyAttachments } from "./createLiveOntologyAttachments.js";

export type OntologyObject = Record<string, unknown>;
export interface OntologyDefinition {
    objectTypes: Record<string, OntologyObject>;
    actionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
        }
    >;
    queryTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
            returnType: unknown;
        }
    >;
}

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

export interface LiveOntologyActionExecution {
    mutationFn: () => Promise<void>;
    mutator: () => void;
}

export type LiveOntologyAction<Parameters extends Record<string, unknown> = Record<string, unknown>> = (
    parameters: Parameters
) => LiveOntologyActionExecution;

export type LiveOntologyQuery<
    Parameters extends Record<string, unknown> = Record<string, unknown>,
    Return = unknown,
> = (parameters: Parameters) => Promise<Return>;

export type LiveOntologyObjects<
    ObjectTypes extends OntologyDefinition["objectTypes"] = OntologyDefinition["objectTypes"],
> = {
    [ObjectTypeName in keyof ObjectTypes]: OntologyCollection<ObjectTypes[ObjectTypeName]>;
};

export type LiveOntologyActions<ActionTypes extends OntologyDefinition["actionTypes"]> = {
    [ActionTypeName in keyof ActionTypes]: LiveOntologyAction<ActionTypes[ActionTypeName]["parameters"]>;
};

export type LiveOntologyQueries<QueryTypes extends OntologyDefinition["queryTypes"]> = {
    [QueryTypeName in keyof QueryTypes]: LiveOntologyQuery<
        QueryTypes[QueryTypeName]["parameters"],
        QueryTypes[QueryTypeName]["returnType"]
    >;
};

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
    queries: LiveOntologyQueries<Ontology["queryTypes"]>;
    attachments?: LiveOntologyAttachments;
    cleanup: () => Promise<void>;
}

export interface LiveOntologyOpts {
    id?: string;
    ir: OntologyIR;
    adapter: OntologyAdapter;
    blobStore?: BlobStoreProvider;
    getContext?: () => Record<string, unknown>;
}

function decorateCollectionSync(opts: {
    ir: OntologyIR;
    objectType: OntologyIR["objectTypes"][number];
    collectionOptions: ReturnType<OntologyAdapter["getCollectionOptions"]>;
}): ReturnType<OntologyAdapter["getCollectionOptions"]> {
    return {
        ...opts.collectionOptions,
        sync: {
            ...opts.collectionOptions.sync,
            sync: (syncParams) =>
                opts.collectionOptions.sync.sync({
                    ...syncParams,
                    write: (message) => {
                        if (message.type === "delete") {
                            syncParams.write(message);
                            return;
                        }
                        syncParams.write({
                            ...message,
                            value: decorateObjectAttachmentSources({
                                ir: opts.ir,
                                objectType: opts.objectType,
                                object: message.value,
                            }),
                        });
                    },
                }),
        },
    };
}

export function createLiveOntology<Ontology extends OntologyDefinition = OntologyDefinition>(
    opts: LiveOntologyOpts
): LiveOntology<Ontology> {
    const ontologyId = opts.id ?? crypto.randomUUID();
    const blobStore = (opts.blobStore ?? createInMemoryBlobStore)(ontologyId);
    const attachmentsAdapter = opts.adapter.attachments;
    const blobManager = attachmentsAdapter
        ? createBlobManager({
              store: blobStore,
              remote: {
                  blob: (id, readOptions) =>
                      attachmentsAdapter.getAttachmentContent({
                          id,
                          source: readOptions?.meta?.source as attachment["source"],
                      }),
                  metadata: (id, readOptions) =>
                      attachmentsAdapter.getAttachmentMetadata({
                          id,
                          source: readOptions?.meta?.source as attachment["source"],
                      }),
              },
          })
        : undefined;
    const attachments =
        attachmentsAdapter && blobManager
            ? createLiveOntologyAttachments({
                  ir: opts.ir,
                  attachmentsAdapter,
                  blobManager,
              })
            : undefined;
    const objects = Object.fromEntries(
        opts.ir.objectTypes.map((objectType) => {
            const collectionOptions = decorateCollectionSync({
                ir: opts.ir,
                objectType,
                collectionOptions: opts.adapter.getCollectionOptions(objectType.name),
            });
            const collection = createCollection({
                ...collectionOptions,
                id: `${ontologyId}:${objectType.name}`,
                defaultIndexType: BasicIndex,
                autoIndex: "eager",
                getKey: (object) =>
                    (object as Record<string, string | number>)[objectType.primaryKey] as string | number,
            }) as OntologyCollection<OntologyObject>;

            return [objectType.name, collection];
        })
    ) as Record<string, OntologyCollection<OntologyObject>>;
    const actions = Object.fromEntries(
        opts.ir.actionTypes.map((action) => [
            action.name,
            (providedParameters: Record<string, unknown>) => {
                const context = opts.getContext?.() ?? {};
                const parameters = resolveActionParameters(
                    opts.ir,
                    action.name,
                    providedParameters,
                    context,
                    objects
                );

                return {
                    mutationFn: async () => {
                        const preparedAction: PreparedActionParameters = await prepareActionParameters({
                            ir: opts.ir,
                            actionTypeName: action.name,
                            parameters,
                            adapter: opts.adapter,
                            blobManager,
                        });
                        await opts.adapter.applyAction(action.name, preparedAction.parameters, {
                            objects: objects as Record<string, Collection<Record<string, unknown>>>,
                            context,
                            attachmentUploads: preparedAction.attachmentUploads,
                        });
                    },
                    mutator: () => {
                        applyActionLogic({
                            ir: opts.ir,
                            actionTypeName: action.name,
                            parameters,
                            context,
                            objects,
                        });
                    },
                };
            },
        ])
    );
    const queries = Object.fromEntries(
        opts.ir.queryTypes.map((queryType) => [
            queryType.name,
            (parameters: Record<string, unknown>) => {
                const context = opts.getContext?.() ?? {};
                return opts.adapter.runQuery(queryType.name, parameters, {
                    objects: objects as Record<string, Collection<Record<string, unknown>>>,
                    context,
                });
            },
        ])
    );

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
        actions: actions as unknown as LiveOntologyActions<Ontology["actionTypes"]>,
        queries: queries as unknown as LiveOntologyQueries<Ontology["queryTypes"]>,
        attachments,
        cleanup: async () => {
            await Promise.all(Object.values(objects).map((collection) => collection.cleanup()));
            await opts.adapter.cleanup?.();
        },
    };
}
