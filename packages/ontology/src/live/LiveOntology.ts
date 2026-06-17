import {
    createBlobManager,
    createInMemoryBlobStore,
    type BlobManager,
    type BlobStoreProvider,
} from "@party-stack/blobs";
import { BasicIndex, Collection, createCollection } from "@tanstack/db";
import { applyActionLogic } from "./applyActionLogic.js";
import { decorateObjectAttachmentSources } from "./attachmentSources.js";
import {
    createLiveOntologyAttachments,
    type LiveOntologyAttachments,
} from "./createLiveOntologyAttachments.js";
import { resolveActionParameters } from "./expression.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
import type {
    OntologyAdapter,
    OntologyApplyActionResult,
    OntologyAttachmentsAdapter,
} from "./OntologyAdapter.js";
import type { PreparedActionParameters } from "./prepareActionParameters.js";
import type { OntologyIR } from "../ir/index.js";
import type { OntologyObject } from "../utils/OntologyObject.js";
import type { attachment } from "../utils/values.js";

export type { LiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
export interface OntologyDefinition {
    objectTypes: Record<string, OntologyObject>;
    actionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
        }
    >;
    queryFunctionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
            returnType: unknown;
        }
    >;
}

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

export interface LiveOntologyActionExecution {
    mutationFn: () => Promise<OntologyApplyActionResult | void>;
    mutator: () => void;
}

export type LiveOntologyAction<Parameters extends Record<string, unknown> = Record<string, unknown>> = (
    parameters: Parameters
) => LiveOntologyActionExecution;

export type LiveOntologyQueryFunction<
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

export type LiveOntologyQueryFunctions<QueryFunctionTypes extends OntologyDefinition["queryFunctionTypes"]> = {
    [QueryFunctionTypeName in keyof QueryFunctionTypes]: LiveOntologyQueryFunction<
        QueryFunctionTypes[QueryFunctionTypeName]["parameters"],
        QueryFunctionTypes[QueryFunctionTypeName]["returnType"]
    >;
};

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
    queryFunctions: LiveOntologyQueryFunctions<Ontology["queryFunctionTypes"]>;
    attachments: LiveOntologyAttachments;
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

const unsupportedOntologyAttachmentsAdapter: OntologyAttachmentsAdapter = {
    getAttachmentContent: (attachment) =>
        Promise.reject(new Error(`Ontology adapter cannot read attachment content for "${attachment.id}".`)),
    getAttachmentMetadata: (attachment) =>
        Promise.reject(new Error(`Ontology adapter cannot read attachment metadata for "${attachment.id}".`)),
};

export function createLiveOntology<Ontology extends OntologyDefinition = OntologyDefinition>(
    opts: LiveOntologyOpts
): LiveOntology<Ontology> {
    const ontologyId = opts.id ?? crypto.randomUUID();
    const blobStore = (opts.blobStore ?? createInMemoryBlobStore)(ontologyId);
    const attachmentsAdapter = opts.adapter.attachments ?? unsupportedOntologyAttachmentsAdapter;
    const blobManager: BlobManager = createBlobManager({
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
    });
    const attachments = createLiveOntologyAttachments({
        ir: opts.ir,
        attachmentsAdapter,
        blobManager,
    });
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
                        const result = await opts.adapter.applyAction(action.name, preparedAction.parameters, {
                            objects: objects as Record<string, Collection<Record<string, unknown>>>,
                            context,
                            attachmentUploads: preparedAction.attachmentUploads,
                        });
                        await Promise.all(
                            (result?.attachmentIdMappings ?? []).map((mapping) =>
                                blobManager.markUploaded(mapping.localId, {
                                    remoteId: mapping.remoteId,
                                })
                            )
                        );
                        return result;
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
    const queryFunctions = Object.fromEntries(
        opts.ir.queryFunctionTypes.map((queryFunctionType) => [
            queryFunctionType.name,
            (parameters: Record<string, unknown>) => {
                const context = opts.getContext?.() ?? {};
                return opts.adapter.runQueryFunction(queryFunctionType.name, parameters, {
                    objects: objects as Record<string, Collection<Record<string, unknown>>>,
                    context,
                });
            },
        ])
    );

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
        actions: actions as unknown as LiveOntologyActions<Ontology["actionTypes"]>,
        queryFunctions: queryFunctions as unknown as LiveOntologyQueryFunctions<Ontology["queryFunctionTypes"]>,
        attachments,
        cleanup: async () => {
            await Promise.all(Object.values(objects).map((collection) => collection.cleanup()));
            await opts.adapter.cleanup?.();
        },
    };
}
