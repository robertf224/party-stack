import { createBlobManager, type BlobManager } from "@party-stack/blobs";
import { createDefaultRuntime, type RuntimeAdapterProvider } from "@party-stack/runtime";
import { type Collection } from "@tanstack/db";
import { provide } from "../utils/provide.js";
import { createLiveOntologyActions } from "./actions/createLiveOntologyActions.js";
import {
    createLiveOntologyAttachments,
    type LiveOntologyAttachments,
} from "./attachments/createLiveOntologyAttachments.js";
import { unsupportedOntologyAttachmentsAdapter } from "./attachments/unsupportedOntologyAttachmentsAdapter.js";
import { createLiveOntologyObjectCollection } from "./objects/createLiveOntologyObjectCollection.js";
import type { LiveOntologyAction } from "./actions/createLiveOntologyAction.js";
import type { OntologyMutatorRegistry } from "./mutators/types.js";
import type { OntologyCollection } from "./objects/createLiveOntologyObjectCollection.js";
import type { OntologyObject } from "./objects/OntologyObject.js";
import type { OntologyBackendAdapter, OntologyBackendAdapterProvider } from "./OntologyBackendAdapter.js";
import type { OntologyOutbox } from "./outbox/types.js";
import type { OntologyIR } from "../ir/index.js";
import type { attachment } from "../utils/values.js";

export type { LiveOntologyAction, LiveOntologyActionOptions } from "./actions/createLiveOntologyAction.js";
export type { LiveOntologyAttachments } from "./attachments/createLiveOntologyAttachments.js";
export type { OntologyCollection } from "./objects/createLiveOntologyObjectCollection.js";

export type LiveOntologyWriteMode = "direct" | "outbox";

export type LiveOntologyWriteVisibility = "confirmed" | "optimistic";

export type LiveOntologyOutboxFailureStrategy = "pause" | "discard-all";

export interface LiveOntologyOutboxOptions {
    failureStrategy?: LiveOntologyOutboxFailureStrategy;
    maxRetries?: number;
}

export interface LiveOntologyWrites {
    defaultMode?: LiveOntologyWriteMode;
    defaultVisibility?: LiveOntologyWriteVisibility;
    mutators?: OntologyMutatorRegistry;
    outbox?: LiveOntologyOutboxOptions;
}

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
    outbox: OntologyOutbox;
    cleanup: () => Promise<void>;
}

export interface CreateLiveOntologyOpts<Context extends Record<string, unknown> = Record<string, unknown>> {
    id?: string;
    ir: OntologyIR;
    backend: OntologyBackendAdapterProvider<NoInfer<Context>>;
    runtime?: RuntimeAdapterProvider;
    persistObjects?: boolean;
    writes?: LiveOntologyWrites;
    context?: Context;
    getUserId?: (context: Context) => string;
}

export async function createLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateLiveOntologyOpts<Context>): Promise<LiveOntology<Ontology>> {
    const ontologyId = opts.id ?? "default";
    const context = (opts.context ?? {}) as Context;
    const owner = opts.getUserId?.(context) ?? "anonymous";
    const backendAdapter: OntologyBackendAdapter = await provide(opts.backend, opts.ir, context);
    const runtime = await provide(opts.runtime ?? createDefaultRuntime, owner, ontologyId);
    const attachmentsAdapter = backendAdapter.attachments ?? unsupportedOntologyAttachmentsAdapter;
    const blobManager: BlobManager = createBlobManager({
        runtime,
        remote: {
            read: (id, readOptions) =>
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
                ir: opts.ir,
                objectType,
                backendAdapter,
                runtime,
                persistObjects: opts.persistObjects ?? false,
            }),
        ])
    ) as Record<string, OntologyCollection<OntologyObject>>;
    const actionsSubsystem = createLiveOntologyActions({
        ir: opts.ir,
        backendAdapter,
        runtime,
        context,
        objects,
        blobManager,
        writes: opts.writes,
    });
    const queryFunctions = Object.fromEntries(
        opts.ir.queryFunctionTypes.map((queryFunctionType) => [
            queryFunctionType.name,
            (parameters: Record<string, unknown>) =>
                backendAdapter.runQueryFunction(queryFunctionType.name, parameters, {
                    objects: objects as Record<string, Collection<Record<string, unknown>>>,
                    context,
                }),
        ])
    );

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
        actions: actionsSubsystem.actions as unknown as LiveOntologyActions<Ontology["actionTypes"]>,
        queryFunctions: queryFunctions as unknown as LiveOntologyQueryFunctions<
            Ontology["queryFunctionTypes"]
        >,
        attachments,
        outbox: actionsSubsystem.outbox,
        cleanup: async () => {
            await actionsSubsystem.outbox.cleanup();
            await Promise.all(Object.values(objects).map((collection) => collection.cleanup()));
            await blobManager.cleanup();
            await backendAdapter.cleanup?.();
            await runtime.cleanup?.();
        },
    };
}
