import { classifyBackendFailure, BackendError } from "@party-stack/ontology-backend";
import { OntologyDescriptionCodec } from "@party-stack/ontology-backend/description";
import { pull } from "@party-stack/ontology-backend/meta";
import { protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { makeTraceCapture } from "@party-stack/runtime/tracing";
import { Context, Effect, Exit, Layer, LayerMap, Scope, Schema, Semaphore, Tracer } from "effect";
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
}
export type ReplicaRegistration = ReplicaRegistrationCommon & {
    readonly source?: OntologySource;
    /** Accepted protocol binding for the first definition, retained for an offline restart. */
    readonly bootstrap?: OntologyDescription;
    /**
     * Static or dynamic (see `makeReplica`). A dynamic replica reopens under the definition it
     * last had open, then follows its metadata, so it starts offline.
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
    /** The context the partition was opened for. Reopening with the same context reuses the
     * partition without reading the definition first. */
    readonly context?: Record<string, unknown>;
    readonly bootstrap?: OntologyDescription;
    /** @deprecated Written by older versions, which stored the definition here; read as the
     * definition to open under until the replica's metadata has it. */
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
        context: Schema.optional(protocolValueCodec(Schema.Record(Schema.String, Schema.Unknown))),
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
    // Through the value codec: keys are ordered and dates, bigints, maps and sets are kept.
    const recordIdentity = Table.make<unknown>({ name: "record-identity" });
    const recordKey = (input: unknown) => {
        try {
            return recordIdentity.encode(input);
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
    const sameContext = (left: Record<string, unknown>, right: Record<string, unknown>) =>
        recordKey(left) !== undefined && recordKey(left) === recordKey(right);
    /** A bootstrap must describe the same upstream source, for the account the partition holds. */
    const checkBootstrap = (
        description: OntologyDescription,
        stored?: Pick<StoredReplicaPartition, "bootstrap" | "context">
    ) =>
        stored?.context !== undefined && !sameContext(description.context ?? {}, stored.context)
            ? Effect.fail(
                  new BackendError({
                      operation: "replica.bootstrap",
                      kind: "SourceMismatch",
                      retryable: false,
                      message: "The bootstrap belongs to a different context.",
                  })
              )
            : stored?.bootstrap &&
                (stored.bootstrap.sourceId !== description.sourceId ||
                    stored.bootstrap.replication !== description.replication)
              ? Effect.fail(
                    new BackendError({
                        operation: "replica.bootstrap",
                        kind: "SourceMismatch",
                        retryable: false,
                        message: "The bootstrap belongs to a different upstream source.",
                    })
                )
              : Effect.void;
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
                const definition = configuration.definition;
                const context = configuration.context ?? {};
                const stored = yield* protect(metadata.tables.get(table, ontology));
                const namespace = partitionNamespace(configuration.namespace ?? ontology);
                // The partition this context was opened in before. A dynamic replica reopens in
                // it without reading its definition: its metadata replica, stored there, has it,
                // so it starts without the network.
                const storedContext = stored?.context ?? stored?.definition?.context;
                const known =
                    stored?.partition.namespace === namespace &&
                    storedContext !== undefined &&
                    sameContext(storedContext, context)
                        ? stored
                        : undefined;
                // The storage partition depends on the definition's context, so a first open
                // reads the definition before the replica can open.
                const ir =
                    definition.kind === "static"
                        ? definition.ir
                        : (known?.definition?.ir ??
                          (known ? undefined : yield* pull(definition.meta, definition.select ?? {})));
                if (!ir && !known)
                    return yield* new BackendError({
                        operation: "replica.definition",
                        kind: "Unavailable",
                        retryable: true,
                        message: "The replica's definition could not be read.",
                    });
                const partition =
                    known && definition.kind !== "static"
                        ? known.partition
                        : yield* Effect.try({
                              try: () => ({ owner: contextPartition(ir!, context), namespace }),
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
                if (configuration.bootstrap) {
                    yield* checkBootstrap(configuration.bootstrap, known);
                    if (
                        typeof configuration.backend !== "function" &&
                        configuration.bootstrap.sourceId !== configuration.backend.sourceId
                    )
                        return yield* new BackendError({
                            operation: "replica.bootstrap",
                            kind: "SourceMismatch",
                            retryable: false,
                            message: "The bootstrap does not describe the selected backend.",
                        });
                }
                const runtime = yield* protect(runtimes.acquire(partition));
                const traces = yield* makeTraceCapture();
                const work = makeReplica({
                    ...configuration,
                    // Only a definition an older version recorded: a first open waits for the
                    // replica's metadata replica, so the metadata is cached before it returns.
                    ...(definition.kind !== "static" && known?.definition
                        ? { retained: known.definition.ir }
                        : {}),
                }).pipe(Effect.provideService(Runtime, runtime));
                const replica = yield* traces
                    ? work.pipe(Effect.provideService(Tracer.Tracer, traces.tracer))
                    : work;
                // Reopening the same partition for the same context needs no rewrite. Records
                // from older versions are rewritten without the definition they kept.
                const unchanged =
                    stored !== undefined &&
                    stored.context !== undefined &&
                    !stored.definition &&
                    !stored.rebuild &&
                    stored.partition.owner === partition.owner &&
                    stored.partition.namespace === partition.namespace &&
                    sameContext(stored.context, context) &&
                    stored.bootstrap === configuration.bootstrap;
                if (!unchanged)
                    yield* protect(
                        metadata.tables.put(table, ontology, {
                            ontology,
                            partition,
                            context,
                            ...(configuration.bootstrap ? { bootstrap: configuration.bootstrap } : {}),
                        })
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
                            yield* checkBootstrap(description, stored);
                            yield* tx.put(table, ontology, { ...stored, bootstrap: description });
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
