import {
    createBlobManager,
    createInMemoryBlobStore,
    type BlobManager,
    type BlobStore,
} from "@party-stack/blobs";
import { type Collection } from "@tanstack/db";
import { createLiveOntologyAction } from "./actions/createLiveOntologyAction.js";
import {
    createLiveOntologyAttachments,
    type LiveOntologyAttachments,
} from "./attachments/createLiveOntologyAttachments.js";
import { unsupportedOntologyAttachmentsAdapter } from "./attachments/unsupportedOntologyAttachmentsAdapter.js";
import { createLiveOntologyObjectCollection } from "./objects/createLiveOntologyObjectCollection.js";
import type { LiveOntologyAction } from "./actions/createLiveOntologyAction.js";
import type { OntologyCollection } from "./objects/createLiveOntologyObjectCollection.js";
import type { OntologyObject } from "./objects/OntologyObject.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";
import type { attachment } from "../utils/values.js";

export type { LiveOntologyAction, LiveOntologyActionExecution } from "./actions/createLiveOntologyAction.js";
export type { LiveOntologyAttachments } from "./attachments/createLiveOntologyAttachments.js";
export type { OntologyCollection } from "./objects/createLiveOntologyObjectCollection.js";
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

export type LiveOntologyQueryFunctions<QueryFunctionTypes extends OntologyDefinition["queryFunctionTypes"]> =
    {
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

export interface CreateLiveOntologyOpts<Context extends Record<string, unknown> = Record<string, unknown>> {
    id?: string;
    ir: OntologyIR;
    adapter: OntologyAdapter;
    blobStore?: (opts: { owner: string; namespace: string }) => BlobStore;
    context?: Context;
    getUserId?: (context: Context) => string;
}

export function createLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateLiveOntologyOpts<Context>): LiveOntology<Ontology> {
    const ontologyId = opts.id ?? "default";
    const context = (opts.context ?? {}) as Context;
    const blobStore = opts.blobStore
        ? opts.blobStore({
              owner: opts.getUserId?.(context) ?? "anonymous",
              namespace: ontologyId,
          })
        : createInMemoryBlobStore();
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
        opts.ir.objectTypes.map((objectType) => [
            objectType.name,
            createLiveOntologyObjectCollection({
                ontologyId,
                ir: opts.ir,
                objectType,
                adapter: opts.adapter,
            }),
        ])
    ) as Record<string, OntologyCollection<OntologyObject>>;
    const actions = Object.fromEntries(
        opts.ir.actionTypes.map((action) => [
            action.name,
            createLiveOntologyAction({
                ir: opts.ir,
                action,
                adapter: opts.adapter,
                context,
                objects,
                blobManager,
            }),
        ])
    );
    const queryFunctions = Object.fromEntries(
        opts.ir.queryFunctionTypes.map((queryFunctionType) => [
            queryFunctionType.name,
            (parameters: Record<string, unknown>) =>
                opts.adapter.runQueryFunction(queryFunctionType.name, parameters, {
                    objects: objects as Record<string, Collection<Record<string, unknown>>>,
                    context,
                }),
        ])
    );

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
        actions: actions as unknown as LiveOntologyActions<Ontology["actionTypes"]>,
        queryFunctions: queryFunctions as unknown as LiveOntologyQueryFunctions<
            Ontology["queryFunctionTypes"]
        >,
        attachments,
        cleanup: async () => {
            await Promise.all(Object.values(objects).map((collection) => collection.cleanup()));
            await opts.adapter.cleanup?.();
        },
    };
}
