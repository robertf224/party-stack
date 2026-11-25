import { classifyBackendFailure, BackendError } from "@party-stack/ontology-backend";
import { OntologyDescriptionCodec } from "@party-stack/ontology-backend/description";
import { protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { makeTraceCapture } from "@party-stack/runtime/tracing";
import {
    Context,
    Effect,
    Exit,
    Layer,
    LayerMap,
    Option,
    Scope,
    Schema,
    Semaphore,
    Stream,
    Tracer,
} from "effect";
import { replicaBackend } from "./internal.js";
import { makeReplica } from "./make.js";
import type { ReplicaBackendFactory } from "./make.js";
import type { ReplicaConfiguration, ReplicaDefinition, ReplicaService } from "./service.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { RuntimePartition, RuntimeService } from "@party-stack/runtime";
import type { TraceStore } from "@party-stack/runtime/tracing";

export interface ReplicaRegistrationCommon extends Omit<ReplicaConfiguration, "ir"> {
    /** Defaults to the selected ontology name. Independent of the authenticated partition. */
    readonly namespace?: string;
    /** Host-owned storage migrations run before the native replica is opened, with the first
     * definition it opens under. */
    readonly beforeOpen?: (runtime: RuntimeService, ir: OntologyIR) => Effect.Effect<void, BackendError>;
}
export type ReplicaRegistration = ReplicaRegistrationCommon & {
    readonly source?: OntologySource;
    /** Accepted protocol binding for the first definition, retained for an offline restart. */
    readonly bootstrap?: OntologyDescription;
    /**
     * Static or dynamic (see `makeReplica`). A dynamic replica reopens under the definition it
     * last had open, then follows the source, so it starts offline.
     */
    readonly definition: ReplicaDefinition;
    readonly backend: OntologyBackendService | ReplicaBackendFactory;
};
export interface RegisteredReplica {
    readonly ir: ReplicaConfiguration["ir"];
    readonly context: Record<string, unknown>;
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly runtime: RuntimeService;
    readonly traces?: TraceStore;
}
export interface StoredReplicaPartition {
    readonly ontology: string;
    readonly partition: RuntimePartition["Service"];
    readonly bootstrap?: OntologyDescription;
    readonly definition?: { readonly ir: OntologyIR; readonly context: Record<string, unknown> };
    /** @deprecated Written by older versions as a pending replacement; read as the bootstrap. */
    readonly rebuild?: { readonly description: OntologyDescription };
}
/** Partition inventory and native acquisition for a host that owns resource lifetimes. */
export const makeReplicaPartitionCatalog = Effect.fn("ReplicaPartitions.make")(function* (scope?: string) {
    if (scope !== undefined && !Schema.is(Schema.NonEmptyString)(scope))
        return yield* new BackendError({
            operation: "replica-registry.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Replica scope must be nonempty when provided.",
        });
    const runtimes = yield* Runtimes;
    const protect = <A, E, R>(work: Effect.Effect<A, E, R>, operation = "replica-registry") =>
        work.pipe(Effect.mapError((error) => classifyBackendFailure(operation, error)));
    const metadata = yield* protect(
        runtimes.acquire({
            owner: "replica-registry",
            namespace: scope === undefined ? "default" : JSON.stringify(["replica-scope", scope]),
        })
    );
    const partitionNamespace = (namespace: string) =>
        scope === undefined ? namespace : JSON.stringify(["replica-scope", scope, namespace]);
    const codec = Schema.Struct({
        ontology: Schema.NonEmptyString,
        partition: Schema.Struct({ owner: Schema.String, namespace: Schema.NonEmptyString }),
        bootstrap: Schema.optional(OntologyDescriptionCodec),
        definition: Schema.optional(
            Schema.Struct({
                ir: protocolValueCodec(OntologyIRSchema),
                context: protocolValueCodec(Schema.Record(Schema.String, Schema.Unknown)),
            })
        ),
        rebuild: Schema.optional(Schema.Struct({ description: OntologyDescriptionCodec })),
    });
    // A record retains a full definition. Lookup, open and restore all read the
    // same stored row; decoding and validating a large provider IR repeatedly
    // dominates native startup. Reuse the decoded record for identical stored
    // data. Records are immutable values, so sharing one decoding is safe and
    // also lets per-definition signature caches recognize the same IR.
    const decodeRecord = Schema.decodeUnknownSync(codec);
    const decoded = new Map<string, StoredReplicaPartition>();
    const recordKey = (input: unknown) => {
        try {
            return JSON.stringify(input);
        } catch {
            return undefined;
        }
    };
    const decodeCached = (input: unknown) => {
        const key = recordKey(input);
        if (key === undefined) return decodeRecord(input);
        const cached = decoded.get(key);
        if (cached) {
            decoded.delete(key);
            decoded.set(key, cached);
            return cached;
        }
        const value = decodeRecord(input);
        decoded.set(key, value);
        if (decoded.size > 8) decoded.delete(decoded.keys().next().value!);
        return value;
    };
    const table = Table.make<StoredReplicaPartition>({
        name: "replica-partitions",
        codec: { encode: Schema.encodeSync(codec), decode: decodeCached },
    });

    const active = new Map<string, { scope: Scope.Closeable }>();
    const partitionOwners = new Map<string, string>();
    const gate = yield* Semaphore.make(1);
    const checkBootstrap = Effect.fnUntraced(function* (
        partition: RuntimePartition["Service"],
        description: OntologyDescription,
        previous?: OntologyDescription
    ) {
        const ir = description.ir;
        if (!ir)
            return yield* new BackendError({
                operation: "replica.bootstrap",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "A cached bootstrap requires an ontology definition.",
            });
        const owner = yield* Effect.try({
            try: () => contextPartition(ir, description.context ?? {}),
            catch: (cause) =>
                new BackendError({
                    operation: "replica.bootstrap",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "The bootstrap has an invalid context partition.",
                    cause,
                }),
        });
        if (owner !== partition.owner)
            return yield* new BackendError({
                operation: "replica.bootstrap",
                kind: "SourceMismatch",
                retryable: false,
                message: "The bootstrap belongs to a different context partition.",
            });
        if (
            previous &&
            (previous.sourceId !== description.sourceId || previous.replication !== description.replication)
        )
            return yield* new BackendError({
                operation: "replica.bootstrap",
                kind: "SourceMismatch",
                retryable: false,
                message: "The bootstrap belongs to a different upstream source.",
            });
        return ir;
    });
    const open = Effect.fn("ReplicaPartitions.open")(function* (
        ontology: string,
        configuration: ReplicaRegistration
    ) {
        if (active.has(ontology))
            return yield* new BackendError({
                operation: "replica.open",
                kind: "Conflict",
                retryable: false,
                message: "This replica already has an active owner.",
            });
        const scope = yield* Scope.fork(yield* Effect.scope);
        const entry = { scope };
        active.set(ontology, entry);
        yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
                if (active.get(ontology) === entry) active.delete(ontology);
            })
        );
        return yield* Scope.provide(
            Effect.gen(function* () {
                const source = configuration.definition;
                const followed = source.kind === "dynamic" ? source : undefined;
                const stored = yield* protect(metadata.tables.get(table, ontology));
                // A followed replica reopens under the definition it last had open (or the
                // accepted bootstrap), then follows its source: it starts without the network.
                const namespace = partitionNamespace(configuration.namespace ?? ontology);
                const retained = followed
                    ? (configuration.bootstrap?.ir ??
                      (stored?.partition.namespace === namespace &&
                      stored.definition &&
                      contextPartition(stored.definition.ir, configuration.context ?? {}) ===
                          stored.partition.owner
                          ? stored.definition.ir
                          : undefined))
                    : undefined;
                const ir =
                    source.kind === "static"
                        ? source.ir
                        : (retained ?? Option.getOrUndefined(yield* Stream.runHead(source.changes)));
                let primed = false;
                const definition: ReplicaDefinition =
                    followed && retained
                        ? {
                              ...followed,
                              // Once only: the follower subscribes again after a source failure.
                              changes: Stream.suspend(() => {
                                  if (primed) return followed.changes;
                                  primed = true;
                                  return Stream.concat(Stream.make(retained), followed.changes);
                              }),
                          }
                        : source;
                if (!ir)
                    return yield* new BackendError({
                        operation: "replica.definition",
                        kind: "Unavailable",
                        retryable: true,
                        message: "The definition source ended before supplying a definition.",
                    });
                const partition = yield* Effect.try({
                    try: () => ({
                        owner: contextPartition(ir, configuration.context ?? {}),
                        namespace,
                    }),
                    catch: (cause) => classifyBackendFailure("replica-registry.partition", cause),
                });
                const partitionKey = JSON.stringify([partition.owner, partition.namespace]);
                const previous = partitionOwners.get(partitionKey);
                if (previous && previous !== ontology)
                    return yield* new BackendError({
                        operation: "replica-registry.acquire",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message:
                            "Different ontology names resolved to the same replica partition. Resolve aliases to a canonical name before acquisition.",
                    });
                partitionOwners.set(partitionKey, ontology);
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        if (partitionOwners.get(partitionKey) === ontology)
                            partitionOwners.delete(partitionKey);
                    })
                );
                const rebuilding = stored;
                if (configuration.bootstrap) {
                    const bootstrap = configuration.bootstrap;
                    const bootstrapIR = yield* checkBootstrap(partition, bootstrap);
                    if (bootstrapIR !== ir) {
                        const same = yield* Effect.try({
                            try: () =>
                                ontologyDefinitionSignature(bootstrapIR) === ontologyDefinitionSignature(ir),
                            catch: (cause) =>
                                new BackendError({
                                    operation: "replica.bootstrap",
                                    kind: "InvalidConfiguration",
                                    retryable: false,
                                    message: "The bootstrap has an invalid ontology definition.",
                                    cause,
                                }),
                        });
                        if (!same)
                            return yield* new BackendError({
                                operation: "replica.bootstrap",
                                kind: "SchemaMismatch",
                                retryable: false,
                                message: "The bootstrap does not describe the selected replica definition.",
                            });
                    }
                    if (
                        typeof configuration.backend !== "function" &&
                        bootstrap.sourceId !== configuration.backend.sourceId
                    )
                        return yield* new BackendError({
                            operation: "replica.bootstrap",
                            kind: "SourceMismatch",
                            retryable: false,
                            message: "The bootstrap does not describe the selected backend.",
                        });
                }
                const runtime = yield* protect(runtimes.acquire(partition));
                if (configuration.beforeOpen) yield* configuration.beforeOpen(runtime, ir);
                const traces = yield* makeTraceCapture();
                const work = makeReplica({ ...configuration, definition }).pipe(
                    Effect.provideService(Runtime, runtime)
                );
                const replica = yield* traces
                    ? work.pipe(Effect.provideService(Tracer.Tracer, traces.tracer))
                    : work;
                // Do not replace the last usable bootstrap when opening the
                // native replica rejects a source or definition mismatch.
                // Reopening an unchanged retained definition needs no rewrite.
                const unchanged =
                    rebuilding !== undefined &&
                    !rebuilding.rebuild &&
                    rebuilding.partition.owner === partition.owner &&
                    rebuilding.partition.namespace === partition.namespace &&
                    rebuilding.definition?.ir === ir &&
                    JSON.stringify(rebuilding.definition.context) ===
                        JSON.stringify(configuration.context ?? {}) &&
                    rebuilding.bootstrap === configuration.bootstrap;
                if (!unchanged)
                    yield* protect(
                        metadata.tables.put(table, ontology, {
                            ontology,
                            partition,
                            definition: { ir, context: configuration.context ?? {} },
                            ...(configuration.bootstrap ? { bootstrap: configuration.bootstrap } : {}),
                        })
                    );
                // Remember each definition a followed replica reopens under, so the next start
                // opens under it without its source.
                if (followed)
                    yield* replica.definition.changes.pipe(
                        // The replica may already have reopened by the time this subscribes.
                        Stream.filter((next) => next !== ir),
                        Stream.runForEach((next) =>
                            gate.withPermit(
                                protect(
                                    metadata.tables.transaction((tx) =>
                                        Effect.gen(function* () {
                                            const saved = yield* tx.get(table, ontology);
                                            if (!saved || saved.definition?.ir === next) return;
                                            yield* tx.put(table, ontology, {
                                                ...saved,
                                                definition: {
                                                    ir: next,
                                                    context: configuration.context ?? {},
                                                },
                                            });
                                        })
                                    )
                                )
                            )
                        ),
                        Effect.catch((error) =>
                            Effect.logWarning("Could not record the new definition", error)
                        ),
                        Effect.forkScoped
                    );
                return {
                    ir: replica.ir,
                    context: configuration.context ?? {},
                    replica,
                    // A followed definition may build its backend per definition; servers read
                    // the current one from the replica.
                    backend: replicaBackend(replica) ?? (configuration.backend as OntologyBackendService),
                    runtime,
                    traces,
                };
            }),
            scope
        ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)));
    });
    return {
        lookup: (ontology: string, expectedPartition?: RuntimePartition["Service"]) =>
            protect(metadata.tables.get(table, ontology)).pipe(
                Effect.map((stored) =>
                    stored &&
                    (!expectedPartition ||
                        (stored.partition.owner === expectedPartition.owner &&
                            stored.partition.namespace === expectedPartition.namespace))
                        ? stored
                        : undefined
                )
            ),
        saveBootstrap: (ontology: string, description: OntologyDescription) =>
            gate.withPermit(
                protect(
                    metadata.tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const stored = yield* tx.get(table, ontology);
                            if (!stored)
                                return yield* new BackendError({
                                    operation: "replica.bootstrap",
                                    kind: "NotFound",
                                    retryable: false,
                                    message: "The replica partition has not been opened.",
                                });
                            const ir = yield* checkBootstrap(stored.partition, description, stored.bootstrap);
                            yield* tx.put(table, ontology, {
                                ...stored,
                                bootstrap: description,
                                definition: { ir, context: description.context ?? {} },
                            });
                        })
                    )
                )
            ),
        open: (ontology: string, configuration: ReplicaRegistration) =>
            gate.withPermit(open(ontology, configuration)),
        partitions: protect(
            metadata.tables.query(table).pipe(Effect.map((rows) => rows.map((row) => row.value)))
        ),
        forget: (ontology: string) =>
            gate.withPermit(
                Effect.gen(function* () {
                    const entry = active.get(ontology);
                    if (entry) yield* Scope.close(entry.scope, Exit.void);
                    const stored = yield* protect(
                        metadata.tables.get(table, ontology),
                        "replica.forget.lookup"
                    );
                    if (!stored) return;
                    const shared = (yield* protect(
                        metadata.tables.query(table),
                        "replica.forget.inventory"
                    )).some(
                        (row) =>
                            row.value.ontology !== ontology &&
                            row.value.partition.owner === stored.partition.owner &&
                            row.value.partition.namespace === stored.partition.namespace
                    );
                    if (!shared) {
                        const scope = yield* Scope.make();
                        const runtime = yield* Scope.provide(
                            protect(runtimes.acquire(stored.partition), "replica.forget.open"),
                            scope
                        ).pipe(
                            Effect.onExit((exit) =>
                                Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void
                            )
                        );
                        yield* Scope.close(scope, Exit.void);
                        yield* protect(runtime.destroy, "replica.forget.destroy");
                    }
                    yield* protect(metadata.tables.delete(table, ontology), "replica.forget.remove");
                })
            ),
    };
});

/** Standalone native sharing; transport servers use the same catalog beneath their route ownership. */
export const makeReplicaRegistry = Effect.fn("ReplicaRegistry.make")(function* (options: {
    /** Optional storage isolation for registries sharing the same runtime platform. */
    readonly scope?: string;
    readonly idleRetentionMs?: number;
    readonly resolve: (ontology: string) => Effect.Effect<ReplicaRegistration, BackendError, Scope.Scope>;
}) {
    if (
        (options.scope !== undefined && !Schema.is(Schema.NonEmptyString)(options.scope)) ||
        (options.idleRetentionMs !== undefined &&
            (!Number.isFinite(options.idleRetentionMs) || options.idleRetentionMs < 0))
    )
        return yield* new BackendError({
            operation: "replica-registry.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message:
                "Registry scope must be nonempty when provided and idle retention must be finite and nonnegative.",
        });
    const catalog = yield* makeReplicaPartitionCatalog(options.scope);
    class Opened extends Context.Service<Opened, RegisteredReplica>()("ReplicaRegistry/Opened") {}
    const replicas = yield* LayerMap.make(
        (ontology: string) =>
            Layer.effect(
                Opened,
                Effect.flatMap(options.resolve(ontology), (configuration) =>
                    catalog.open(ontology, configuration)
                )
            ),
        { idleTimeToLive: options.idleRetentionMs ?? 60_000 }
    );
    const gate = yield* Semaphore.make(1);
    return {
        acquire: (ontology: string) =>
            gate.withPermit(
                Effect.map(replicas.contextEffect(ontology), (context) => Context.get(context, Opened))
            ),
        partitions: catalog.partitions,
        forget: (ontology: string) =>
            gate.withPermit(replicas.invalidate(ontology).pipe(Effect.andThen(catalog.forget(ontology)))),
    };
});
