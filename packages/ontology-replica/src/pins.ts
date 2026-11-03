import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import { collectObjectAttachments } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Queue, Schema, Scope, Semaphore, Stream, PubSub, Cause } from "effect";
import { Fiber } from "effect";
import { retentionQuery } from "./retention.js";
import type { ReplicaService } from "./engine.js";
import type { BackendAttachments } from "@party-stack/ontology-backend";
import type { QueryEntity } from "@party-stack/ontology-backend/query";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
import type { QueryDocument, OntologyIR } from "@party-stack/ontology-spec";
import type { BlobStorageService } from "@party-stack/ontology-storage/blobs";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export interface PinOptions {
    readonly inputs?: Record<string, unknown>;
    readonly attachments?: "none" | "all";
}
interface PinDefinition extends PinOptions {
    readonly generation: string;
    readonly query: QueryDocument;
}
interface PinState {
    readonly desired: PinDefinition;
    readonly installed?: PinDefinition;
    readonly error?: { readonly kind: BackendError["kind"]; readonly message: string };
}
export interface PinStatus {
    readonly query: QueryDocument;
    readonly inputs?: Record<string, unknown>;
    readonly attachments: "none" | "all";
    readonly ready: boolean;
    readonly previousGraphRetained: boolean;
    readonly error?: { readonly kind: BackendError["kind"]; readonly message: string };
}

/** One durable desired graph and its last complete predecessor. Candidate demand
 * is scoped; membership, byte roots and the installed generation switch together.
 */
export const makeQueryPin = Effect.fn("Replica.queryPin")(function* (options: {
    readonly engine: ReplicaService;
    readonly tables: TablesService;
    readonly namespace: string;
    readonly ir: OntologyIR;
    readonly context?: Record<string, unknown>;
    readonly live: boolean;
    readonly blobs?: BlobStorageService;
    readonly attachments?: Pick<BackendAttachments, "read">;
}) {
    const { engine, tables, ir } = options;
    const attachmentReferences = (entity: QueryEntity) =>
        collectObjectAttachments(
            ir,
            entity.objectType,
            Object.fromEntries([...entity.properties].map((property) => [property, entity.value[property]]))
        );
    const settingsSchema = Schema.Struct({
        inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        attachments: Schema.optional(Schema.Literals(["none", "all"])),
    });
    const name = (part: string) => JSON.stringify(["replica", options.namespace, part]);
    const state = Table.make<PinState>({ name: name("query-pin") });
    const rows = Table.make<{ objectType: string; key: string | number }>({ name: name("pins") });
    const owner = name("query-pin-bytes"),
        pendingOwner = name("query-pin-pending-bytes");
    const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(Effect.mapError((cause) => classifyBackendFailure("replica.pin", cause)));
    const queue = yield* Queue.sliding<void>(1);
    const events = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const changed = PubSub.publish(events, undefined).pipe(Effect.asVoid);
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const gate = yield* Semaphore.make(1);
    const parent = yield* Effect.scope;
    let inFlight: Fiber.Fiber<void, BackendError> | undefined;
    let retryFiber: Fiber.Fiber<void> | undefined;
    let activeScope: Scope.Closeable | undefined;
    yield* Effect.addFinalizer(() => (activeScope ? Scope.close(activeScope, Exit.void) : Effect.void));
    // A previous process cannot still own a candidate under exclusive store ownership.
    if (options.blobs)
        yield* boundary(tables.transaction((tx) => options.blobs!.in(tx).release(pendingOwner)));
    const refresh = gate.withPermit(
        Effect.gen(function* () {
            if (retryFiber) yield* Fiber.interrupt(retryFiber);
            retryFiber = undefined;
            const current = yield* boundary(tables.get(state, "head"));
            if (!current) return;
            const desired = current.desired;
            const candidate = yield* Scope.fork(parent);
            const acquired = new Map<string, CompiledSubset>();
            let retained = false;
            const acquire = Effect.fnUntraced(function* (subset: CompiledSubset) {
                const key = Table.make<CompiledSubset>({ name: "scan" }).encode(subset);
                if (!acquired.has(key)) {
                    yield* Scope.provide(engine.demand(subset), candidate);
                    acquired.set(key, subset);
                }
                const snapshot = yield* Effect.scoped(
                    Effect.gen(function* () {
                        // Subscribe before readiness: a speculative parent's initial frame
                        // can precede the metadata-only batch proving complete coverage.
                        const changes = yield* engine.subscribeChanges;
                        yield* engine.syncSubset(subset);
                        const first = yield* engine.snapshotSubset(subset, false);
                        if (
                            first.complete ||
                            engine.mode !== "protocol" ||
                            !(yield* engine.connectivity.online)
                        )
                            return first;
                        const next = yield* Stream.concat(
                            Stream.make(first),
                            changes.pipe(Stream.mapEffect(() => engine.snapshotSubset(subset, false)))
                        ).pipe(
                            Stream.filter((value) => value.complete),
                            Stream.runHead,
                            Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.succeed(undefined) })
                        );
                        return next && next._tag === "Some" ? next.value : first;
                    })
                );
                if (!snapshot.complete)
                    return yield* new BackendError({
                        operation: "replica.pin",
                        kind: "Unavailable",
                        retryable: true,
                        message: "Offline pin is waiting for complete upstream coverage.",
                    });
                return snapshot.rows;
            });
            const execute = (reader: Parameters<typeof executeQuery>[1]["reader"]) =>
                executeQuery(desired.query, {
                    reader,
                    inputs: desired.inputs,
                    context: options.context,
                    mode: "entity",
                });
            const result = yield* Effect.result(
                Effect.gen(function* () {
                    // Discover correlated subsets outside the local transaction. Repeat only
                    // when the atomic local evaluation discovers a newly required subset.
                    for (let pass = 0; pass < 16; pass++) {
                        const discovered = yield* execute({
                            ir,
                            loadSubset: (objectType, query) => acquire({ objectType, query }),
                        });
                        const references = discovered.entities.flatMap(attachmentReferences);
                        const ids = [...new Set(references.map((ref) => ref.attachment.id))];
                        if (desired.attachments === "all" && ids.length > 0) {
                            if (!options.blobs || !options.attachments)
                                return yield* new BackendError({
                                    operation: "replica.pin",
                                    kind: "NotImplemented",
                                    retryable: false,
                                    message:
                                        "Offline attachment downloads require local byte storage and upstream attachment reads.",
                                });
                            yield* boundary(
                                tables.transaction((tx) =>
                                    options.blobs!.in(tx).retain(pendingOwner, ids, { bytes: true })
                                )
                            );
                            for (const reference of references) {
                                const meta = yield* boundary(options.blobs.metadata(reference.attachment.id));
                                if (meta?.byteKey) continue;
                                yield* Effect.scoped(
                                    Effect.gen(function* () {
                                        const bytes = yield* options.attachments!.read(reference.attachment);
                                        yield* boundary(options.blobs!.cache(reference.attachment.id, bytes));
                                    })
                                );
                            }
                        }
                        const missing = new Map<string, CompiledSubset>();
                        const dependencies = new Map<string, { objectType: string; key: string | number }>();
                        const installed = yield* engine.localTransaction((tx, read) =>
                            Effect.gen(function* () {
                                if ((yield* tx.get(state, "head"))?.desired.generation !== desired.generation)
                                    return false;
                                const evaluated = yield* execute({
                                    ir,
                                    loadSubset: (objectType, query) =>
                                        Effect.gen(function* () {
                                            const subset = { objectType, query };
                                            const key = Table.make<CompiledSubset>({ name: "scan" }).encode(
                                                subset
                                            );
                                            if (
                                                !acquired.has(key) ||
                                                !(yield* boundary(engine.hasCoverage(tx, subset)))
                                            )
                                                missing.set(key, subset);
                                            for (const row of yield* read.loadSubset(
                                                objectType,
                                                retentionQuery(query)
                                            ))
                                                dependencies.set(JSON.stringify([objectType, row.key]), {
                                                    objectType,
                                                    key: row.key,
                                                });
                                            return yield* read.loadSubset(objectType, query);
                                        }),
                                });
                                const attachments = evaluated.entities.flatMap(attachmentReferences);
                                const finalIds = [...new Set(attachments.map((ref) => ref.attachment.id))];
                                if (
                                    missing.size ||
                                    (desired.attachments === "all" &&
                                        finalIds.some((id) => !ids.includes(id)))
                                )
                                    return false;
                                if (desired.attachments === "all" && finalIds.length > 0)
                                    yield* boundary(options.blobs!.in(tx).requireBytes(finalIds));
                                yield* tx.clear(rows);
                                for (const entity of evaluated.entities)
                                    dependencies.set(JSON.stringify([entity.objectType, entity.key]), {
                                        objectType: entity.objectType,
                                        key: entity.key,
                                    });
                                for (const [key, dependency] of dependencies)
                                    yield* tx.put(rows, key, dependency);
                                if (options.blobs)
                                    yield* boundary(
                                        options.blobs
                                            .in(tx)
                                            .retain(owner, desired.attachments === "all" ? finalIds : [], {
                                                bytes: true,
                                            })
                                    );
                                yield* tx.put(state, "head", { desired, installed: desired });
                                return true;
                            })
                        );
                        if (installed) {
                            const previous = activeScope;
                            activeScope = candidate;
                            retained = true;
                            if (previous) yield* Scope.close(previous, Exit.void);
                            return;
                        }
                        if (
                            (yield* boundary(tables.get(state, "head")))?.desired.generation !==
                            desired.generation
                        )
                            return;
                        for (const subset of missing.values()) yield* acquire(subset);
                    }
                    return yield* new BackendError({
                        operation: "replica.pin",
                        kind: "Unavailable",
                        retryable: true,
                        message:
                            "The query changed while acquiring its offline graph; retrying on the next change.",
                    });
                }).pipe(
                    Effect.ensuring(
                        Effect.gen(function* () {
                            if (!retained) yield* Scope.close(candidate, Exit.void);
                            if (options.blobs)
                                yield* boundary(
                                    tables.transaction((tx) => options.blobs!.in(tx).release(pendingOwner))
                                ).pipe(
                                    Effect.catch((error) =>
                                        Effect.logWarning("Offline pin cleanup failed", { kind: error.kind })
                                    )
                                );
                        })
                    )
                )
            );
            if (result._tag === "Failure")
                yield* boundary(
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const latest = yield* tx.get(state, "head");
                            if (latest?.desired.generation === desired.generation)
                                yield* tx.put(state, "head", {
                                    ...latest,
                                    error: { kind: result.failure.kind, message: result.failure.message },
                                });
                        })
                    )
                );
            if (options.live && result._tag === "Failure" && result.failure.retryable)
                retryFiber = yield* Effect.forkIn(
                    Effect.sleep(Math.max(5_000, result.failure.retryAfterMs ?? 0)).pipe(
                        Effect.andThen(Queue.offer(queue, undefined)),
                        Effect.asVoid
                    ),
                    parent
                );
            yield* changed;
        })
    );
    const wake = Queue.offer(queue, undefined).pipe(Effect.asVoid);
    if (options.live) {
        const changes = yield* engine.visibleChanges;
        yield* Stream.runForEach(changes, () => wake).pipe(Effect.forkScoped);
        yield* Stream.runForEach(engine.connectivity.changes, (online) => (online ? wake : Effect.void)).pipe(
            Effect.forkScoped
        );
        if (engine.connection)
            yield* Stream.runForEach(engine.connection.changes, (state) =>
                state.status === "active" ? wake : Effect.void
            ).pipe(Effect.forkScoped);
        yield* Effect.forever(
            Effect.gen(function* () {
                yield* Queue.take(queue);
                const worker = yield* Effect.forkChild(refresh);
                inFlight = worker;
                const result = yield* Fiber.await(worker);
                inFlight = undefined;
                if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause))
                    yield* Effect.logWarning("Offline pin refresh failed", {
                        cause: Cause.pretty(result.cause),
                    });
            })
        ).pipe(Effect.forkScoped);
        yield* wake;
    }
    return {
        setPin: Effect.fn("Replica.setPin")(function* (query: QueryDocument, settings?: PinOptions) {
            settings = yield* Schema.decodeUnknownEffect(settingsSchema)(settings ?? {}).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "replica.pin",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "Invalid pin options.",
                            cause,
                        })
                )
            );
            const document = yield* Schema.decodeUnknownEffect(QueryDocumentSchema)(query).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "replica.pin",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "Invalid pin query.",
                            cause,
                        })
                )
            );
            // Validate entity selections and inputs without acquiring upstream data.
            yield* executeQuery(document, {
                reader: { ir, loadSubset: () => Effect.succeed([]) },
                context: options.context,
                inputs: settings?.inputs,
                mode: "entity",
            });
            yield* boundary(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const previous = yield* tx.get(state, "head");
                        yield* tx.put(state, "head", {
                            desired: { ...settings, query: document, generation: crypto.randomUUID() },
                            installed: previous?.installed,
                        });
                    })
                )
            );
            yield* changed;
            if (inFlight) yield* Fiber.interrupt(inFlight);
            if (options.live) yield* wake;
            else yield* refresh;
        }),
        clearPin: Effect.fn("Replica.clearPin")(function* () {
            // Removing desired intent first prevents an older acquisition from publishing.
            yield* engine.localTransaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.delete(state, "head");
                    yield* tx.clear(rows);
                    if (options.blobs) {
                        yield* boundary(options.blobs.in(tx).release(owner));
                        yield* boundary(options.blobs.in(tx).release(pendingOwner));
                    }
                })
            );
            if (inFlight) yield* Fiber.interrupt(inFlight);
            yield* wake;
            yield* gate.withPermit(
                Effect.gen(function* () {
                    if (retryFiber) yield* Fiber.interrupt(retryFiber);
                    retryFiber = undefined;
                    if (activeScope) yield* Scope.close(activeScope, Exit.void);
                    activeScope = undefined;
                })
            );
            yield* changed;
        }),
        pinStatus: boundary(tables.get(state, "head")).pipe(
            Effect.map(
                (head): PinStatus | undefined =>
                    head && {
                        query: head.desired.query,
                        inputs: head.desired.inputs,
                        attachments: head.desired.attachments ?? "none",
                        ready: head.desired.generation === head.installed?.generation && !head.error,
                        previousGraphRetained: Boolean(
                            head.installed && head.installed.generation !== head.desired.generation
                        ),
                        error: head.error,
                    }
            )
        ),
        refresh,
        changes: Stream.fromPubSub(events),
    };
});
