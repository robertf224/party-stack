import type { OntologyDefinition } from "@party-stack/ontology-spec";
export type { OntologyDefinition } from "@party-stack/ontology-spec";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { createDefaultRuntime, type RuntimeAdapterProvider } from "@party-stack/runtime";
import { Effect, Exit, Scope } from "effect";
import { makeReplicaLiveOntology } from "../runtime/live.js";
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

/** Admission policy, not completion timing. Both modes await authoritative confirmation.
 * Direct requires connectivity; outbox also accepts writes while offline.
 */
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
    /** Scoped source-collection and query-identity owner. Supply to React's DbProvider or query options.
     * The current TanStack release does not register browser hook queries for client cleanup.
     */
    readonly dbClient: import("@tanstack/db").DbClient;
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

/**
 * Waits for LiveOntology subsystems required before safe use.
 */
export async function waitForLiveOntologyReady(ontology: LiveOntology): Promise<void> {
    await ontology.ready;
}

/** Native acquisition. Runtime, backend, collections and replica fibers share the caller's Scope. */
export const makeLiveOntology = Effect.fn("Ontology.make")(function* <
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateLiveOntologyOpts<Context>) {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const opened = Effect.gen(function* () {
        const ontologyId = opts.id ?? "default";
        const context = (opts.context ?? {}) as Context;
        const owner = yield* Effect.try({
            try: () => contextPartition(opts.ir, context),
            catch: (cause) =>
                new BackendError({
                    operation: "runtime.partition",
                    kind: "InvalidConfiguration",
                    message: "Invalid context partition.",
                    retryable: false,
                    cause,
                }),
        });
        const runtime = yield* (opts.runtime ?? createDefaultRuntime)(owner, ontologyId);
        const platform = runtime.adapter;
        const resources = yield* Scope.fork(runtime.scope);
        if (runtime.scope !== scope) yield* Scope.addFinalizer(scope, Scope.close(resources, Exit.void));
        return yield* Scope.provide(
            Effect.gen(function* () {
                const backendAdapter = yield* Effect.tryPromise({
                    try: () => provide(opts.backend, opts.ir, context),
                    catch: (cause) => classifyBackendFailure("backend.configure", cause),
                });
                if (opts.persistObjects && !platform.tables) {
                    return yield* Effect.fail(
                        new BackendError({
                            operation: "ontology.make",
                            kind: "InvalidConfiguration",
                            retryable: false,
                            message: "Persisted ontology objects require owned Tables storage.",
                        })
                    );
                }
                const live = yield* makeReplicaLiveOntology({
                    ir: opts.ir,
                    context,
                    runtime: platform,
                    backendAdapter,
                    writes: opts.writes,
                    connection: opts.connection,
                }).pipe(Effect.provide(runtime.context));
                let closing: Promise<void> | undefined;
                const cleanup = () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void)));
                return {
                    ...live,
                    cleanup,
                    destroy: async () => {
                        await cleanup();
                        await platform.destroy?.();
                    },
                } as LiveOntology<Ontology>;
            }),
            resources
        );
    });
    return yield* Scope.provide(opened, scope).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
    );
});

/** UI/SDK boundary; the native service above owns all implementation and cleanup. */
export async function createLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateLiveOntologyOpts<Context>): Promise<LiveOntology<Ontology>> {
    const scope = Effect.runSync(Scope.make());
    try {
        const live = await Effect.runPromise(Scope.provide(makeLiveOntology<Ontology, Context>(opts), scope));
        let closing: Promise<void> | undefined;
        const cleanup = () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void)));
        return {
            ...live,
            cleanup,
            destroy: async () => {
                await cleanup();
                await live.destroy();
            },
        };
    } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
        throw cause;
    }
}
