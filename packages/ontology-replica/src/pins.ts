import { BackendError, BackendErrorKindSchema, classifyBackendFailure } from "@party-stack/ontology-backend";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import { collectObjectAttachments } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Queue, Schema, Scope, Semaphore, Stream, PubSub, Cause, Tracer } from "effect";
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
export interface PinDefinition extends PinOptions {
    readonly generation: string;
    readonly query: QueryDocument;
}
export interface PinState {
    readonly desired: PinDefinition;
    /** Durable cancellation work survives process exit before roots are released. */
    readonly removed?: boolean;
    readonly installed?: PinDefinition;
    readonly error?: { readonly kind: BackendError["kind"]; readonly message: string };
}
export interface PinGraph {
    readonly query: QueryDocument;
    readonly inputs?: Record<string, unknown>;
    readonly attachments: "none" | "all";
}
export interface PinStatus extends PinGraph {
    readonly ready: boolean;
    readonly previousGraphRetained: boolean;
    /** Last completed graph kept available while the desired graph is replaced. */
    readonly retainedGraph?: PinGraph;
    readonly error?: { readonly kind: BackendError["kind"]; readonly message: string };
}

export const PinOptionsSchema = Schema.Struct({
    inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    attachments: Schema.optional(Schema.Literals(["none", "all"])),
});
const PinGraphSchema = Schema.Struct({
    query: QueryDocumentSchema,
    inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    attachments: Schema.Literals(["none", "all"]),
});
export const PinStatusSchema = Schema.Struct({
    ...PinGraphSchema.fields,
    ready: Schema.Boolean,
    previousGraphRetained: Schema.Boolean,
    retainedGraph: Schema.optional(PinGraphSchema),
    error: Schema.optional(Schema.Struct({ kind: BackendErrorKindSchema, message: Schema.String })),
});

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
    /** Independent acquisition within the owning replica's shared retention set. */
    readonly id?: string;
    readonly onStatusChanged?: Effect.Effect<void, BackendError>;
}) {
    const { engine, tables, ir } = options;
    const tracer = yield* Tracer.Tracer;
    const attachmentReferences = (entity: QueryEntity) =>
        collectObjectAttachments(
            ir,
            entity.objectType,
            Object.fromEntries([...entity.properties].map((property) => [property, entity.value[property]]))
        );
    const name = (part: string) => JSON.stringify(["replica", options.namespace, part]);
    const id = options.id ?? "head";
    const state = Table.make<PinState>({ name: name("query-pin") });
    type Member = { objectType: string; key: string | number };
    const rows = Table.make<Member & { owners?: readonly string[] }>({ name: name("pins") });
    const members = Table.make<Member>({
        name: JSON.stringify(["replica", options.namespace, "pin-members", id]),
    });
    const owner = id === "head" ? name("query-pin-bytes") : name(`query-pin-bytes:${id}`),
        pendingOwner =
            id === "head" ? name("query-pin-pending-bytes") : name(`query-pin-pending-bytes:${id}`);
    const releaseMember = Effect.fnUntraced(function* (
        tx: import("@party-stack/ontology-storage/tables").Transaction,
        key: string | number
    ) {
        const previous = yield* tx.get(rows, key);
        const owners = previous?.owners?.filter((owner) => owner !== id) ?? [];
        if (previous && owners.length) yield* tx.put(rows, key, { ...previous, owners });
        else yield* tx.delete(rows, key);
        yield* tx.delete(members, key);
    });
    const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(Effect.mapError((cause) => classifyBackendFailure("replica.pin", cause)));
    // Adopt the original singleton's roots without changing their retention.
    if (id === "head")
        yield* boundary(
            tables.transaction((tx) =>
                Effect.gen(function* () {
                    for (const row of yield* tx.query(rows)) {
                        if (row.value.owners) continue;
                        yield* tx.put(members, row.key, row.value);
                        yield* tx.put(rows, row.key, { ...row.value, owners: [id] });
                    }
                })
            )
        );
    const queue = yield* Queue.sliding<void>(1);
    const events = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const changed = PubSub.publish(events, undefined).pipe(
        Effect.andThen(options.onStatusChanged ?? Effect.void)
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const gate = yield* Semaphore.make(1);
    const commands = yield* Semaphore.make(1);
    let closed = false;
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            closed = true;
        }).pipe(Effect.andThen(commands.withPermit(Effect.void)))
    );
    const command = <A, R>(work: Effect.Effect<A, BackendError, R>) =>
        commands.withPermit(
            Effect.suspend(() =>
                closed
                    ? Effect.fail(
                          new BackendError({
                              operation: "replica.pin",
                              kind: "Unavailable",
                              retryable: false,
                              message: "The replica owner is closed.",
                          })
                      )
                    : work
            )
        );
    const parent = yield* Effect.scope;
    let inFlight: Fiber.Fiber<void, BackendError> | undefined;
    let retryFiber: Fiber.Fiber<void> | undefined;
    let activeScope: Scope.Closeable | undefined;
    // Deduplicate notifications already included in a successful atomic install.
    // Retain only its revision and scoped demands, never graph rows or results.
    let reconciled:
        | { generation: string; visibleRevision: number; subsets: readonly CompiledSubset[] }
        | undefined;
    yield* Effect.addFinalizer(() => (activeScope ? Scope.close(activeScope, Exit.void) : Effect.void));
    // A previous process cannot still own a candidate under exclusive store ownership.
    if (options.blobs)
        yield* boundary(tables.transaction((tx) => options.blobs!.in(tx).release(pendingOwner)));
    const refresh = gate
        .withPermit(
            Effect.gen(function* () {
                if (retryFiber) yield* Fiber.interrupt(retryFiber);
                retryFiber = undefined;
                const snapshot = yield* boundary(
                    tables.read((tx) =>
                        Effect.gen(function* () {
                            const current = yield* tx.get(state, id);
                            if (
                                !activeScope ||
                                !reconciled ||
                                !current ||
                                current.error ||
                                current.desired.generation !== reconciled.generation ||
                                current.installed?.generation !== reconciled.generation ||
                                (yield* engine.visibleRevision(tx)) !== reconciled.visibleRevision
                            )
                                return { current, unchanged: false };
                            for (const subset of reconciled.subsets)
                                if (!(yield* engine.hasCoverage(tx, subset)))
                                    return { current, unchanged: false };
                            return { current, unchanged: true };
                        })
                    )
                );
                if (snapshot.unchanged) return;
                let current = snapshot.current;
                if (current?.error && !current.removed) {
                    current = yield* boundary(
                        tables.transaction((tx) =>
                            Effect.gen(function* () {
                                const latest = yield* tx.get(state, id);
                                if (!latest?.error || latest.removed) return latest;
                                const next = { desired: latest.desired, installed: latest.installed };
                                yield* tx.put(state, id, next);
                                return next;
                            })
                        )
                    );
                    yield* changed;
                }
                if (!current || current.removed) {
                    yield* engine.localTransaction((tx) =>
                        Effect.gen(function* () {
                            const latest = yield* tx.get(state, id);
                            if (latest && !latest.removed) return;
                            for (const row of yield* tx.query(members)) yield* releaseMember(tx, row.key);
                            if (options.blobs) {
                                yield* boundary(options.blobs.in(tx).release(owner));
                                yield* boundary(options.blobs.in(tx).release(pendingOwner));
                            }
                            yield* tx.delete(state, id);
                        })
                    );
                    const previous = activeScope;
                    activeScope = undefined;
                    reconciled = undefined;
                    if (previous) yield* Scope.close(previous, Exit.void);
                    yield* changed;
                    return;
                }
                const desired = current.desired;
                const candidate = yield* Scope.fork(parent);
                const acquired = new Map<string, CompiledSubset>();
                let retained = false;
                const acquire = Effect.fn("Replica.pin.acquire")(function* (subset: CompiledSubset) {
                    yield* Effect.annotateCurrentSpan("objectType", subset.objectType);
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
                            if (first.complete || !options.live) return first;
                            // Coverage is readiness, not a request deadline. Keep the
                            // candidate pending until a notification proves completeness
                            // or a newer command cancels this acquisition.
                            const next = yield* Stream.concat(
                                Stream.make(first),
                                changes.pipe(Stream.mapEffect(() => engine.snapshotSubset(subset, false)))
                            ).pipe(
                                Stream.filter((value) => value.complete),
                                Stream.runHead
                            );
                            return next._tag === "Some" ? next.value : first;
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
                                    const meta = yield* boundary(
                                        options.blobs.metadata(reference.attachment.id)
                                    );
                                    if (meta?.byteKey) continue;
                                    yield* Effect.scoped(
                                        Effect.gen(function* () {
                                            const bytes = yield* options.attachments!.read(
                                                reference.attachment
                                            );
                                            yield* boundary(
                                                options.blobs!.cache(reference.attachment.id, bytes)
                                            );
                                        })
                                    );
                                }
                            }
                            const missing = new Map<string, CompiledSubset>();
                            const dependencies = new Map<
                                string,
                                { objectType: string; key: string | number }
                            >();
                            const installed = yield* engine
                                .localTransaction((tx, read) =>
                                    Effect.gen(function* () {
                                        if (
                                            (yield* tx.get(state, id))?.desired.generation !==
                                            desired.generation
                                        )
                                            return undefined;
                                        const evaluated = yield* execute({
                                            ir,
                                            loadSubset: (objectType, query) =>
                                                Effect.gen(function* () {
                                                    const subset = { objectType, query };
                                                    const key = Table.make<CompiledSubset>({
                                                        name: "scan",
                                                    }).encode(subset);
                                                    if (
                                                        !acquired.has(key) ||
                                                        !(yield* boundary(engine.hasCoverage(tx, subset)))
                                                    )
                                                        missing.set(key, subset);
                                                    for (const row of yield* read.loadSubset(
                                                        objectType,
                                                        retentionQuery(query)
                                                    ))
                                                        dependencies.set(
                                                            JSON.stringify([objectType, row.key]),
                                                            {
                                                                objectType,
                                                                key: row.key,
                                                            }
                                                        );
                                                    return yield* read.loadSubset(objectType, query);
                                                }),
                                        });
                                        yield* Effect.annotateCurrentSpan("count", evaluated.entities.length);
                                        const attachments = evaluated.entities.flatMap(attachmentReferences);
                                        const finalIds = [
                                            ...new Set(attachments.map((ref) => ref.attachment.id)),
                                        ];
                                        if (
                                            missing.size ||
                                            (desired.attachments === "all" &&
                                                finalIds.some((id) => !ids.includes(id)))
                                        )
                                            return undefined;
                                        if (desired.attachments === "all" && finalIds.length > 0)
                                            yield* boundary(options.blobs!.in(tx).requireBytes(finalIds));
                                        for (const entity of evaluated.entities)
                                            dependencies.set(
                                                JSON.stringify([entity.objectType, entity.key]),
                                                {
                                                    objectType: entity.objectType,
                                                    key: entity.key,
                                                }
                                            );
                                        // A content edit usually leaves graph membership unchanged.
                                        // Preserve its durable roots rather than rebuilding the graph.
                                        const previous = new Set(
                                            (yield* tx.query(members)).map((row) => row.key)
                                        );
                                        for (const key of previous)
                                            if (!dependencies.has(String(key))) yield* releaseMember(tx, key);
                                        for (const [key, dependency] of dependencies)
                                            if (!previous.has(key)) {
                                                const root = yield* tx.get(rows, key);
                                                yield* tx.put(rows, key, {
                                                    ...dependency,
                                                    owners: [
                                                        ...new Set([
                                                            ...(root?.owners ?? (root ? ["head"] : [])),
                                                            id,
                                                        ]),
                                                    ],
                                                });
                                                yield* tx.put(members, key, dependency);
                                            }
                                        if (options.blobs)
                                            yield* boundary(
                                                options.blobs
                                                    .in(tx)
                                                    .retain(
                                                        owner,
                                                        desired.attachments === "all" ? finalIds : [],
                                                        {
                                                            bytes: true,
                                                        }
                                                    )
                                            );
                                        yield* tx.put(state, id, { desired, installed: desired });
                                        return yield* engine.visibleRevision(tx);
                                    })
                                )
                                .pipe(Effect.withSpan("Replica.pin.install"));
                            if (installed !== undefined) {
                                const previous = activeScope;
                                activeScope = candidate;
                                retained = true;
                                reconciled = {
                                    generation: desired.generation,
                                    visibleRevision: installed,
                                    subsets: [...acquired.values()],
                                };
                                if (previous) yield* Scope.close(previous, Exit.void);
                                return;
                            }
                            if (
                                (yield* boundary(tables.get(state, id)))?.desired.generation !==
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
                                        tables.transaction((tx) =>
                                            options.blobs!.in(tx).release(pendingOwner)
                                        )
                                    ).pipe(
                                        Effect.catch((error) =>
                                            Effect.logWarning("Offline pin cleanup failed", {
                                                kind: error.kind,
                                            })
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
                                const latest = yield* tx.get(state, id);
                                if (latest?.desired.generation === desired.generation)
                                    yield* tx.put(state, id, {
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
            }).pipe(Effect.withSpan("Replica.pin.refresh"))
        )
        .pipe(Effect.provideService(Tracer.Tracer, tracer));
    const wake = Queue.offer(queue, undefined).pipe(Effect.asVoid);
    const scheduleRefresh = Effect.fnUntraced(function* () {
        if (!options.live) return yield* refresh;
        const previous = inFlight;
        // Intent has already committed. Cancellation may have finalizers or an
        // atomic storage operation to finish; it must not block more commands.
        if (previous) yield* Fiber.interrupt(previous).pipe(Effect.forkIn(parent));
        yield* wake;
    });
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
            settings = yield* Schema.decodeUnknownEffect(PinOptionsSchema)(settings ?? {}).pipe(
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
                        const previous = yield* tx.get(state, id);
                        yield* tx.put(state, id, {
                            desired: { ...settings, query: document, generation: crypto.randomUUID() },
                            installed: previous?.installed,
                        });
                    })
                )
            );
            reconciled = undefined;
            yield* changed;
            yield* scheduleRefresh();
        }, command),
        clearPin: Effect.fn("Replica.clearPin")(function* () {
            // Removing desired intent first prevents an older acquisition from publishing.
            yield* engine.localTransaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.delete(state, id);
                    for (const row of yield* tx.query(members)) yield* releaseMember(tx, row.key);
                    if (options.blobs) {
                        yield* boundary(options.blobs.in(tx).release(owner));
                        yield* boundary(options.blobs.in(tx).release(pendingOwner));
                    }
                })
            );
            reconciled = undefined;
            yield* changed;
            yield* scheduleRefresh();
        }, command),
        pinStatus: boundary(tables.get(state, id)).pipe(
            Effect.map((head): PinStatus | undefined =>
                head && !head.removed
                    ? {
                          query: head.desired.query,
                          inputs: head.desired.inputs,
                          attachments: head.desired.attachments ?? "none",
                          ready: head.desired.generation === head.installed?.generation && !head.error,
                          previousGraphRetained: Boolean(
                              head.installed && head.installed.generation !== head.desired.generation
                          ),
                          retainedGraph:
                              head.installed && head.installed.generation !== head.desired.generation
                                  ? {
                                        query: head.installed.query,
                                        inputs: head.installed.inputs,
                                        attachments: head.installed.attachments ?? "none",
                                    }
                                  : undefined,
                          error: head.error,
                      }
                    : undefined
            ),
            Effect.withSpan("Replica.pin.status")
        ),
        refresh,
        scheduleRefresh,
        changes: Stream.fromPubSub(events),
    };
});
