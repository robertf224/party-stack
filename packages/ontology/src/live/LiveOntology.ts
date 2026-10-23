import type { OntologyDefinition } from "@party-stack/ontology-spec";
export type { OntologyDefinition } from "@party-stack/ontology-spec";
import { createDefaultRuntime, type RuntimeAdapterProvider } from "@party-stack/runtime";
import { createReplicaLiveOntology } from "../runtime/live.js";
import { provide } from "../utils/provide.js";
import type { LiveOntologyAction } from "./actions/createLiveOntologyAction.js";
import type { LiveOntologyAttachments } from "./attachments/createLiveOntologyAttachments.js";
import type { OntologyMutatorRegistry } from "./mutators/types.js";
import type { OntologyCollection } from "./objects/types.js";
import type { OntologyBackendAdapterProvider } from "./OntologyBackendAdapter.js";
import type { OntologyOutbox } from "./outbox/types.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { OntologyIR } from "@party-stack/ontology-spec";

export type { LiveOntologyAction, LiveOntologyActionOptions } from "./actions/createLiveOntologyAction.js";
export type { LiveOntologyAttachments } from "./attachments/createLiveOntologyAttachments.js";
export type { OntologyCollection } from "./objects/types.js";

export type LiveOntologyWriteMode = "direct" | "outbox";

export type LiveOntologyWriteVisibility = "confirmed" | "optimistic";

export type LiveOntologyOutboxFailureStrategy = "pause" | "discard-all";

export interface LiveOntologyOutboxOptions {
    failureStrategy?: LiveOntologyOutboxFailureStrategy;
    maxRetries?: number;
    retryDelayMs?: number;
}

export interface LiveOntologyWrites {
    defaultMode?: LiveOntologyWriteMode;
    defaultVisibility?: LiveOntologyWriteVisibility;
    mutators?: OntologyMutatorRegistry;
    outbox?: LiveOntologyOutboxOptions;
}

type OntologyContext<Ontology extends OntologyDefinition> = Ontology extends {
    context: infer Context extends Record<string, unknown>;
}
    ? Context
    : Record<string, unknown>;

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

export interface OntologyDiagnostics {
    readonly label?: string;
    readonly role?: "host" | "replica";
    readonly location?: string;
    readonly replica: import("@party-stack/ontology-replica").ReplicaMonitor;
    readonly traces?: import("@party-stack/runtime").RuntimeTraceStore;
    readonly parent?: OntologyDiagnostics;
}

export interface DecryptOptions {
    /** Default false: bypass the persistent decrypted-value cache. True permits a device-encrypted
     * copy when the response is bound to this ciphertext (see the documented Foundry assumption).
     * Cached device copies are removed with their replica rows.
     */
    readonly cache?: boolean;
    readonly signal?: AbortSignal;
}
export type LiveOntologyDecrypt = <A>(
    value: import("@party-stack/ontology-spec/values").Encrypted<A>,
    options?: DecryptOptions
) => Promise<A>;

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    readonly ir: OntologyIR;
    readonly context: OntologyContext<Ontology>;
    /**
     * Resolves once outbox and blob metadata subsystems have finished starting.
     * Object collections load through consuming queries.
     */
    readonly ready: Promise<void>;
    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    /** Local inspection/query source. Loading it never acquires remote demand. */
    persistedObjects?: LiveOntologyObjects<Ontology["objectTypes"]>;
    traces?: import("@party-stack/runtime").RuntimeTraceStore;
    diagnostics?: OntologyDiagnostics;
    storage?: import("@party-stack/ontology-replica").ReplicaService;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
    queryFunctions: LiveOntologyQueryFunctions<Ontology["queryFunctionTypes"]>;
    attachments: LiveOntologyAttachments<Ontology>;
    /** Explicit decryption of a top-level encrypted property handle. Ordinary queries never decrypt.
     * A provider that only decrypts the property's current value may return a newer value than this
     * handle; without identity evidence that response is never cached, even with cache:true.
     */
    decrypt: LiveOntologyDecrypt;
    /** Remove this value's device-encrypted cached copy, without deleting its authoritative ciphertext. */
    outbox: OntologyOutbox;
    cleanup: () => Promise<void>;
    destroy: () => Promise<void>;
}

export interface CreateLiveOntologyOpts<Context extends Record<string, unknown> = Record<string, unknown>> {
    id?: string;
    ir: OntologyIR;
    backend: OntologyBackendAdapterProvider<NoInfer<Context>>;
    runtime?: RuntimeAdapterProvider;
    persistObjects?: boolean;
    writes?: LiveOntologyWrites;
    context?: Context;
    connection?: ConnectionMonitor;
}

function getContextUserId(context: Record<string, unknown>): string | undefined {
    return typeof context.user === "string" ? context.user : undefined;
}

/**
 * Waits for LiveOntology subsystems required before safe use.
 */
export async function waitForLiveOntologyReady(ontology: LiveOntology): Promise<void> {
    await ontology.ready;
}

export async function createLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateLiveOntologyOpts<Context>): Promise<LiveOntology<Ontology>> {
    const ontologyId = opts.id ?? "default";
    const context = (opts.context ?? {}) as Context;
    const owner = getContextUserId(context) ?? "anonymous";
    const backendAdapter = await provide(opts.backend, opts.ir, context);
    const runtime = await provide(opts.runtime ?? createDefaultRuntime, owner, ontologyId);
    if (opts.persistObjects && !runtime.tables) {
        await Promise.allSettled([
            Promise.resolve().then(() => backendAdapter.cleanup?.()),
            Promise.resolve().then(() => runtime.cleanup?.()),
        ]);
        throw new Error("Persisted ontology objects require owned Tables storage.");
    }
    return createReplicaLiveOntology({
        ir: opts.ir,
        context,
        runtime,
        backendAdapter,
        writes: opts.writes,
        connection: opts.connection,
    }) as Promise<LiveOntology<Ontology>>;
}
