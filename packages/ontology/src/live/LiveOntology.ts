import { createBlobManager, createInMemoryBlobStore, type BlobStoreProvider } from "@party-stack/blobs";
import { BasicIndex, Collection, createCollection } from "@tanstack/db";
import { applyActionLogic } from "./applyActionLogic.js";
import {
    createLiveOntologyAttachments,
    type LiveOntologyAttachments,
} from "./createLiveOntologyAttachments.js";
import { resolveActionParameters } from "./expression.js";
import { materializeActionParameters } from "./materializeActionParameters.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";

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
}

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

export interface LiveOntologyActionExecution {
    mutationFn: () => Promise<void>;
    mutator: () => void;
}

export type LiveOntologyAction<Parameters extends Record<string, unknown> = Record<string, unknown>> = (
    parameters: Parameters
) => LiveOntologyActionExecution;

export type LiveOntologyObjects<
    ObjectTypes extends OntologyDefinition["objectTypes"] = OntologyDefinition["objectTypes"],
> = {
    [ObjectTypeName in keyof ObjectTypes]: OntologyCollection<ObjectTypes[ObjectTypeName]>;
};

export type LiveOntologyActions<ActionTypes extends OntologyDefinition["actionTypes"]> = {
    [ActionTypeName in keyof ActionTypes]: LiveOntologyAction<ActionTypes[ActionTypeName]["parameters"]>;
};

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
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
                  blob: (id) => attachmentsAdapter.getAttachmentContent({ id }),
                  metadata: (id) => attachmentsAdapter.getAttachmentMetadata({ id }),
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
            const collectionOptions = opts.adapter.getCollectionOptions(objectType.name);
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
                        const materializedParameters = await materializeActionParameters({
                            ir: opts.ir,
                            adapter: opts.adapter,
                            actionTypeName: action.name,
                            parameters,
                            blobManager,
                        });
                        await opts.adapter.applyAction(action.name, materializedParameters, {
                            objects: objects as Record<string, Collection<Record<string, unknown>>>,
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

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
        actions: actions as unknown as LiveOntologyActions<Ontology["actionTypes"]>,
        attachments,
        cleanup: async () => {
            await Promise.all(Object.values(objects).map((collection) => collection.cleanup()));
            await opts.adapter.cleanup?.();
        },
    };
}
