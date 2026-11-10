import type { ReplicaService } from "@party-stack/ontology-replica";
import type {
    ReplicaConfiguration,
    ReplicaOptions,
    DemandPolicy,
    ReplicaMonitor,
    PinOptions,
    PinStatus,
} from "@party-stack/ontology-replica";
import type { OntologyDefinition } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";
import type { TraceStore, TraceRecordingMode } from "@party-stack/runtime/tracing";
import type { DbClient } from "@tanstack/db";
export type { OntologyDefinition } from "@party-stack/ontology-spec";
export type { PinOptions, PinStatus, PinGraph } from "@party-stack/ontology-replica";
import { MemoryRuntime, Runtimes, type RuntimesLayer } from "@party-stack/runtime";
import { Effect, Exit, Scope, Layer } from "effect";
import { makeOntologyResource } from "../runtime/resource.js";
import type { LiveOntologyAction } from "./actions/createLiveOntologyAction.js";
import type { LiveOntologyAttachments } from "./attachments/createLiveOntologyAttachments.js";
import type { OntologyMutatorRegistry } from "./mutators/types.js";
import type { OntologyCollection } from "./objects/types.js";
import type { OntologyOutbox } from "./outbox/types.js";
import type { OntologyPins } from "./pins.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { BackendError } from "@party-stack/ontology-backend";
import type { OntologyClient, OntologyServerClient } from "@party-stack/ontology-server/rpc";
import type { OntologyIR, QueryDocument } from "@party-stack/ontology-spec";
import type { Runtime } from "@party-stack/runtime";

export type { LiveOntologyAction, LiveOntologyActionOptions } from "./actions/createLiveOntologyAction.js";
export type { LiveOntologyAttachments } from "./attachments/createLiveOntologyAttachments.js";
export type { OntologyCollection } from "./objects/types.js";

export type LiveOntologyWriteVisibility = "confirmed" | "optimistic";

export type LiveOntologyOutboxFailureStrategy = "pause" | "discard-all";

export type LiveOntologyOutboxOptions = NonNullable<ReplicaConfiguration["outbox"]>;

export interface LiveOntologyWrites {
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
    readonly [ObjectTypeName in keyof ObjectTypes]: OntologyCollection<ObjectTypes[ObjectTypeName]>;
};

export type LiveOntologyActions<ActionTypes extends OntologyDefinition["actionTypes"]> = {
    [ActionTypeName in keyof ActionTypes]: LiveOntologyAction<
        ActionTypes[ActionTypeName]["parameters"],
        ActionTypes[ActionTypeName] extends { returnType: infer Return } ? Return : unknown,
        ActionTypes[ActionTypeName] extends { inputParameters: infer Input extends Record<string, unknown> }
            ? Input
            : ActionTypes[ActionTypeName]["parameters"]
    >;
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
    readonly replica: ReplicaMonitor;
    readonly traces?: TraceStore;
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
export type LiveOntologyDecrypt = <A>(value: Encrypted<A>, options?: DecryptOptions) => Promise<A>;

export interface LiveOntologyPins extends OntologyPins {
    /** The application's current offline graph, including its readiness. */
    get(): Promise<PinStatus | undefined>;
    /** Replace the offline graph, retaining the previous graph until the replacement is ready.
     * Server-backed clients target the parent's persistent replica, including from a memory tab.
     * Standalone clients target their own replica. Attachments default to "none".
     */
    set(query: QueryDocument, options?: PinOptions): Promise<void>;
    clear(name?: string): Promise<void>;
    /** Receives the current pin and subsequent updates. Unsubscribe releases its stream.
     * Native pin failures appear on status.error; transport failures call onError.
     */
    subscribe(
        listener: (status: PinStatus | undefined) => void,
        onError?: (cause: unknown) => void
    ): () => void;
}

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    /** Scoped source-collection and query-identity owner. Supply to React's DbProvider or query options.
     * The current TanStack release does not register browser hook queries for client cleanup.
     */
    readonly dbClient: DbClient;
    readonly ir: OntologyIR;
    readonly context: OntologyContext<Ontology>;
    /** Lazy typed collections. Consuming queries acquire upstream subset demand. */
    readonly objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    /** Lazy cache inspection. These collections retain/observe local visible rows without upstream demand. */
    readonly cachedObjects: LiveOntologyObjects<Ontology["objectTypes"]>;
    traces?: TraceStore;
    diagnostics?: OntologyDiagnostics;
    readonly replica: ReplicaService;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
    queryFunctions: LiveOntologyQueryFunctions<Ontology["queryFunctionTypes"]>;
    attachments: LiveOntologyAttachments<Ontology>;
    /** Explicit decryption of a top-level encrypted property handle. Ordinary queries never decrypt.
     * A provider that only decrypts the property's current value may return a newer value than this
     * handle; without identity evidence that response is never cached, even with cache:true.
     */
    decrypt: LiveOntologyDecrypt;
    outbox: OntologyOutbox;
    readonly pins: LiveOntologyPins;
    cleanup: () => Promise<void>;
}

interface LiveOntologySettings<Context extends Record<string, unknown>> {
    id?: string;
    live?: boolean;
    /** Opt-in devtools trace history or a live-only diagnostic feed. */
    traceRecording?: TraceRecordingMode;
    demand?: DemandPolicy;
    cache?: ReplicaOptions["cache"];
    writes?: LiveOntologyWrites;
    context?: Context;
    authentication?: ConnectionMonitor;
    label?: string;
    /** Attach parent diagnostics, including for committed-only clients.
     * The endpoint must permit internal diagnostics for this caller.
     */
    parent?: { readonly label?: string; readonly location?: string };
}

interface BackendOntologyOptions<
    Context extends Record<string, unknown>,
> extends LiveOntologySettings<Context> {
    ir: OntologyIR;
    /** Borrow an acquired backend, or acquire one in the view's Scope with its Runtime. */
    backend:
        | OntologyBackendService
        | Effect.Effect<OntologyBackendService, BackendError, Scope.Scope | Runtime | Runtimes>;
    client?: never;
    ontology?: never;
}
interface ClientOntologyOptions<
    Context extends Record<string, unknown>,
> extends LiveOntologySettings<Context> {
    /** Defaults to the authenticated server definition. Supply IR to verify it matches this client. */
    ir?: OntologyIR;
    client:
        | OntologyServerClient
        | Effect.Effect<OntologyClient | OntologyServerClient, BackendError, Scope.Scope>;
    /** Select a target on a shared server client; omission selects a single-ontology endpoint. */
    ontology?: string;
    backend?: never;
}
export type LiveOntologyOptions<Context extends Record<string, unknown> = Record<string, unknown>> =
    | BackendOntologyOptions<Context>
    | ClientOntologyOptions<Context>;

export type CreateLiveOntologyOpts<Context extends Record<string, unknown> = Record<string, unknown>> =
    LiveOntologyOptions<Context> & { runtime?: RuntimesLayer };

/** Generated factories supply their IR while preserving the backend/client choice. */
export type LiveOntologyFactoryOptions<Context extends Record<string, unknown> = Record<string, unknown>> = (
    | Omit<BackendOntologyOptions<Context>, "ir">
    | Omit<ClientOntologyOptions<Context>, "ir">
) & { runtime?: RuntimesLayer };

/** SDK acquisition materializes collections only for callers requesting a view. */
export const makeLiveOntology = Effect.fn("Ontology.make")(function* <
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: LiveOntologyOptions<Context>) {
    const resource = yield* makeOntologyResource<Ontology, Context>(opts);
    return yield* resource.view;
});

/** UI/SDK boundary; the native service above owns all implementation and cleanup. */
export async function createLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateLiveOntologyOpts<Context>): Promise<LiveOntology<Ontology>> {
    const scope = Effect.runSync(Scope.make());
    try {
        const context = await Effect.runPromise(
            Layer.buildWithScope(opts.runtime ?? Runtimes.layer(MemoryRuntime.layer), scope)
        );
        const live = await Effect.runPromise(
            Scope.provide(
                makeLiveOntology<Ontology, Context>(opts).pipe(Effect.provideContext(context)),
                scope
            )
        );
        let closing: Promise<void> | undefined;
        const cleanup = () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void)));
        return {
            ...live,
            cleanup,
        };
    } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
        throw cause;
    }
}
