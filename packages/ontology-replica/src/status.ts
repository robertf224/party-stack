import { SourceQueryPlanSchema } from "@party-stack/ontology-backend";
import { BackendSubsetSchema } from "@party-stack/ontology-backend/protocol";
import { Cause, Clock, Effect, Exit, Fiber, Option, PubSub, Schema, Stream } from "effect";
import type { BackendError } from "@party-stack/ontology-backend";
import type { Scope } from "effect";

const Failure = Schema.Struct({ kind: Schema.String, message: Schema.String });
const Outcome = Schema.Literals(["success", "failure", "interrupted"]);
export const ReplicaLoadSchema = Schema.Struct({
    id: Schema.Number,
    spanId: Schema.optional(Schema.String),
    traceId: Schema.optional(Schema.String),
    operation: Schema.Literals(["loadSubset", "pullChanges"]),
    reason: Schema.Literals(["demand", "refresh", "receipt", "repair", "journal"]),
    subset: Schema.optional(BackendSubsetSchema),
    startedAt: Schema.Number,
    finishedAt: Schema.optional(Schema.Number),
    outcome: Schema.Literals(["running", ...Outcome.literals]),
    rows: Schema.optional(Schema.Number),
    fetchedRows: Schema.optional(Schema.Number),
    pushdown: Schema.optional(SourceQueryPlanSchema),
    commits: Schema.optional(Schema.Number),
    complete: Schema.optional(Schema.Boolean),
    error: Schema.optional(Failure),
});
export type ReplicaLoad = Schema.Schema.Type<typeof ReplicaLoadSchema>;
export const ReplicaStatusSchema = Schema.Struct({
    sourceId: Schema.String,
    upstreamId: Schema.String,
    mode: Schema.Literals(["adapter", "protocol"]),
    online: Schema.optional(Schema.Boolean),
    syncing: Schema.Boolean,
    lastSync: Schema.optional(
        Schema.Struct({
            startedAt: Schema.Number,
            finishedAt: Schema.Number,
            outcome: Outcome,
            error: Schema.optional(Failure),
        })
    ),
    demands: Schema.Array(
        Schema.Struct({
            ...BackendSubsetSchema.fields,
            references: Schema.Number,
            watchers: Schema.Number,
            revision: Schema.Number,
            installed: Schema.Number,
            /** Coverage reused by the last completed demand check; diagnostic only. */
            coveredBy: Schema.optional(BackendSubsetSchema),
            coverageProof: Schema.optional(
                Schema.Struct({
                    reason: Schema.Literals(["collection", "query", "primary-key"]),
                    maintainedBy: Schema.Literals(["journal", "watch", "poll"]),
                    pollIntervalMs: Schema.optional(Schema.Number),
                })
            ),
        })
    ),
    outbox: Schema.Record(Schema.String, Schema.Number),
    loads: Schema.Array(ReplicaLoadSchema),
    loadCount: Schema.Number,
});
export type ReplicaStatus = Schema.Schema.Type<typeof ReplicaStatusSchema>;
export interface ReplicaMonitor {
    readonly getSnapshot: () => {
        readonly status?: ReplicaStatus;
        /** A stopped/failed diagnostic stream must not masquerade as live state. */
        readonly error?: string;
    };
    readonly subscribe: (listener: () => void) => () => void;
}

/** Lazy UI boundary. The Scope owns the subscription, including across worker RPC. */
export const makeReplicaMonitor = Effect.fnUntraced(function* (
    statuses: Stream.Stream<ReplicaStatus, BackendError>
): Effect.fn.Return<ReplicaMonitor, never, Scope.Scope> {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const listeners = new Set<() => void>();
    let snapshot: ReturnType<ReplicaMonitor["getSnapshot"]> = {};
    let watcher: Fiber.Fiber<void> | undefined;
    let closed = false;
    const publish = (next: typeof snapshot) =>
        Effect.sync(() => {
            snapshot = next;
            for (const listener of listeners) {
                try {
                    listener();
                } catch {
                    /* Observers do not own the engine. */
                }
            }
        });
    const watch = Stream.runForEach(statuses, (status) => publish({ status })).pipe(
        Effect.catch((error) => publish({ ...snapshot, error: error.message })),
        Effect.andThen(() => publish({ ...snapshot, error: snapshot.error ?? "Replica monitoring stopped." }))
    );
    yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
            closed = true;
            if (watcher) yield* Fiber.interrupt(watcher);
            yield* publish({ ...snapshot, error: "Replica monitoring closed." });
        })
    );
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            if (closed) return () => undefined;
            listeners.add(listener);
            if (!watcher) {
                snapshot = {};
                watcher = Effect.runSyncWith(context)(Effect.forkIn(watch, scope));
            }
            return () => {
                listeners.delete(listener);
                if (!listeners.size && watcher) {
                    Effect.runFork(Fiber.interrupt(watcher));
                    watcher = undefined;
                }
            };
        },
    };
});

/** Bounded metadata only: no returned object rows, action parameters, or blob bytes. */
export const makeReplicaDiagnostics = Effect.fnUntraced(function* () {
    const events = yield* PubSub.sliding<void>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const changed = PubSub.publish(events, undefined).pipe(Effect.asVoid);
    let loads: readonly ReplicaLoad[] = [];
    let count = 0;
    let active = 0;
    let online: boolean | undefined;
    let lastSync: ReplicaStatus["lastSync"];
    const outcome = <A>(exit: Exit.Exit<A, BackendError>) =>
        Exit.isSuccess(exit)
            ? ("success" as const)
            : Cause.hasInterruptsOnly(exit.cause)
              ? ("interrupted" as const)
              : ("failure" as const);
    const failure = <A>(exit: Exit.Exit<A, BackendError>) => {
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return undefined;
        const reason = Cause.findErrorOption(exit.cause);
        return reason._tag === "Some"
            ? { kind: reason.value.kind, message: reason.value.message }
            : { kind: "Defect", message: Cause.pretty(exit.cause) };
    };
    const load = Effect.fnUntraced(function* <A>(
        details: Pick<ReplicaLoad, "operation" | "reason" | "subset">,
        work: Effect.Effect<A, BackendError>,
        summarize: (
            value: A
        ) => Pick<ReplicaLoad, "rows" | "fetchedRows" | "commits" | "complete" | "pushdown">
    ) {
        return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
                const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan));
                const record: ReplicaLoad = {
                    ...details,
                    spanId: span?.spanId,
                    traceId: span?.traceId,
                    id: ++count,
                    startedAt: yield* Clock.currentTimeMillis,
                    outcome: "running",
                };
                loads = [...loads, record].slice(-100);
                yield* changed;
                return record;
            }),
            () => work,
            (record, exit) =>
                Effect.gen(function* () {
                    const finishedAt = yield* Clock.currentTimeMillis;
                    loads = loads.map((entry) =>
                        entry.id === record.id
                            ? {
                                  ...record,
                                  finishedAt,
                                  outcome: outcome(exit),
                                  ...(Exit.isSuccess(exit)
                                      ? summarize(exit.value)
                                      : { error: failure(exit) }),
                              }
                            : entry
                    );
                    yield* changed;
                })
        ).pipe(
            Effect.withSpan(`Replica.upstream.${details.operation}`, {
                attributes: {
                    operation: details.operation,
                    ...(details.subset ? { objectType: details.subset.objectType } : {}),
                },
            })
        );
    });
    const sync = Effect.fnUntraced(function* <A>(work: Effect.Effect<A, BackendError>) {
        return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
                const startedAt = yield* Clock.currentTimeMillis;
                active++;
                yield* changed;
                return startedAt;
            }),
            () => work,
            (startedAt, exit) =>
                Effect.gen(function* () {
                    active--;
                    lastSync = {
                        startedAt,
                        finishedAt: yield* Clock.currentTimeMillis,
                        outcome: outcome(exit),
                        error: failure(exit),
                    };
                    yield* changed;
                })
        );
    });
    return {
        changed,
        subscribe: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        load,
        sync,
        setOnline: (value: boolean) =>
            Effect.sync(() => {
                online = value;
            }).pipe(Effect.andThen(changed)),
        snapshot: () => ({ online, syncing: active > 0, lastSync, loads, loadCount: count }),
    };
});
