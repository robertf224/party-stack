import { it } from "@effect/vitest";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Cause, Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { ConnectionLifecycle, ConnectionState } from "@party-stack/connect";
import type { SubsetWatchEvent } from "@party-stack/ontology-backend";
import type { Query } from "@party-stack/ontology-storage";

// Oracle: the source's own rows. Whatever mix of exact row changes, plain hints,
// missed changes recovered by revalidation, queued actions and slow dispatches
// the replica sees, its confirmed subset must converge to the source's, its
// visible rows must be the confirmed rows plus exactly the predictions it reports
// as applied, and an in-flight action must never be applied twice.

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "value", displayName: "Value", type: o.integer({}) },
                { name: "group", displayName: "Group", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            logic: [],
        },
    ],
};
type Item = { id: string; value: number; group: string };
const watched: Query = { where: eq(field("group"), "a") };
const Id = Schema.Literals(["i0", "i1"]);
const Operation = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("write"),
        id: Id,
        value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
        group: Schema.Literals(["a", "b"]),
        // How the watch reports it: exact row changes, a plain hint, or not at all
        // (a missed change, recovered by revalidation).
        report: Schema.Literals(["changes", "hint", "missed"]),
    }),
    Schema.Struct({ kind: Schema.Literal("delete"), id: Id, report: Schema.Literals(["changes", "hint"]) }),
    Schema.Struct({ kind: Schema.Literal("increment"), id: Id }),
    // lostReadBack: the commit's read-back fails, leaving it committed but unconfirmed.
    // expireWatch: the source rejects the open watch's credential, and the source keeps
    // changing while the watch is down.
    // crashWatch: the adapter's watch stream throws (a defect), and changes go unreported.
    Schema.Struct({
        kind: Schema.Literals(["dispatch", "slowDispatch", "lostReadBack", "expireWatch", "crashWatch"]),
    }),
]);
const Scenario = Schema.Struct({ operations: Schema.Array(Operation).check(Schema.isMaxLength(16)) });

const execute = (
    tx: Parameters<Parameters<typeof makeReplica>[0]["execute"]>[0],
    action: { parameters: Record<string, unknown> }
) =>
    Effect.gen(function* () {
        const id = String(action.parameters.id);
        const row = yield* tx.get("Item", id);
        if (!row)
            return yield* new BackendError({
                operation: "increment",
                kind: "NotFound",
                message: "Object not found.",
                retryable: false,
            });
        yield* tx.put("Item", { ...row, value: Number(row.value) + 1 });
    });

const run = (operations: (typeof Scenario.Type)["operations"]) =>
    Effect.scoped(
        Effect.gen(function* () {
            const server = new Map<string, Item>();
            const watchers = new Set<{
                query: Query | undefined;
                events: Queue.Queue<SubsetWatchEvent, BackendError>;
            }>();
            // A connection that renews a rejected credential when the replica asks.
            let credentialVersion = 0;
            let renewals = 0;
            // Like Connect's monitor: a listener is registered before the current state is sent.
            const listeners = new Set<(state: ConnectionState) => void>();
            const connection: ConnectionLifecycle = {
                state: { status: "active" },
                changes: Stream.callback<ConnectionState>((queue) =>
                    Effect.acquireRelease(
                        Effect.sync(() => {
                            const send = (state: ConnectionState) => {
                                Queue.offerUnsafe(queue, state);
                            };
                            listeners.add(send);
                            send({ status: "active" });
                            return send;
                        }),
                        (send) =>
                            Effect.sync(() => {
                                listeners.delete(send);
                            })
                    )
                ),
                get credentialVersion() {
                    return credentialVersion;
                },
                refresh: (version) =>
                    Effect.gen(function* () {
                        if (version !== credentialVersion) return;
                        renewals++;
                        credentialVersion++;
                        for (const listener of listeners) listener({ status: "active" });
                    }),
            };
            let hold: { committed: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
            let failReadBack = false;
            let committedSinceFailure = false;
            const inSubset = (query: Query | undefined, row: Item | undefined) =>
                row !== undefined && evaluateQuery([{ key: row.id, value: row }], query ?? {}).length > 0;
            const write = (id: string, next: Item | undefined, report: "changes" | "hint" | "missed") =>
                Effect.gen(function* () {
                    const before = server.get(id);
                    if (next) server.set(id, next);
                    else server.delete(id);
                    if (report === "missed") return;
                    for (const watch of watchers) {
                        const was = inSubset(watch.query, before);
                        const is = inSubset(watch.query, next);
                        if (!was && !is) continue;
                        // Like Foundry: puts while in the subset, exits (never deletes) when not.
                        yield* Queue.offer(
                            watch.events,
                            report === "hint"
                                ? undefined
                                : {
                                      changes: [
                                          is
                                              ? { kind: "put" as const, key: id, value: { ...next! } }
                                              : { kind: "exit" as const, key: id },
                                      ],
                                  }
                        );
                    }
                });
            const backend = makeOntologyBackend({
                ir,
                name: "oracle-source",
                sourceId: "oracle-source",
                supportsIdempotency: false,
                queryFunction: () => Effect.void,
                loadSubset: (request) =>
                    Effect.gen(function* () {
                        if (failReadBack && committedSinceFailure) {
                            failReadBack = false;
                            return yield* new BackendError({
                                operation: "loadSubset",
                                kind: "Unavailable",
                                message: "Read-back failed.",
                                retryable: true,
                            });
                        }
                        return yield* compileObjectSubset(ir, request);
                    }).pipe(
                        Effect.map((subset) => ({
                            complete: true,
                            rows: evaluateQuery(
                                [...server.values()].map((row) => ({ key: row.id, value: { ...row } })),
                                subset.query ?? {}
                            ),
                        }))
                    ),
                watchSubset: (request) =>
                    Effect.gen(function* () {
                        const subset = yield* compileObjectSubset(ir, request);
                        const events = yield* Queue.unbounded<SubsetWatchEvent, BackendError>();
                        const watch = { query: subset.query, events };
                        yield* Effect.acquireRelease(
                            Effect.sync(() => watchers.add(watch)),
                            () => Effect.sync(() => watchers.delete(watch))
                        );
                        return Stream.fromQueue(events);
                    }),
                applyAction: (request) =>
                    Effect.gen(function* () {
                        const id = String(request.parameters.id);
                        const row = server.get(id);
                        if (!row)
                            return yield* new BackendError({
                                operation: "applyAction",
                                kind: "NotFound",
                                message: "Object not found.",
                                retryable: false,
                                actionOutcome: "not-committed",
                            });
                        // The watch reports the commit before the receipt reaches the replica.
                        yield* write(id, { ...row, value: row.value + 1 }, "changes");
                        committedSinceFailure = true;
                        if (hold) {
                            yield* Deferred.succeed(hold.committed, undefined);
                            yield* Deferred.await(hold.release);
                        }
                        return {
                            operationId: request.id,
                            outcome: "committed" as const,
                            affected: [{ objectType: "Item", keys: [id] }],
                        };
                    }),
            });
            const replica = yield* makeReplica({
                namespace: "watch-oracle",
                ir,
                tables: yield* Memory.make(),
                backend,
                execute,
                startSync: false,
                objectCacheGc: false,
                outbox: { failureStrategy: "discard-all", retryDelayMs: 0 },
                connection,
            });
            const subset = { objectType: "Item", query: watched };
            yield* replica.demand(subset);
            yield* replica.syncSubset(subset);
            const rows = (values: readonly { value: unknown }[]) =>
                JSON.stringify(
                    values.map((row) => row.value as Item).sort((a, b) => a.id.localeCompare(b.id))
                );
            const expected = () =>
                rows([...server.values()].filter((row) => row.group === "a").map((value) => ({ value })));
            const converged = Effect.gen(function* () {
                // Hints only invalidate; a state-only sync reloads them.
                yield* Effect.result(replica.syncSubset(subset));
                return rows(yield* replica.confirmed.loadSubset("Item", watched)) === expected();
            });
            // Watch events already reported are applied before the next step: a real watch
            // reports every later change too, so a step must not overtake its events.
            const drained = Effect.gen(function* () {
                for (const watch of watchers) if ((yield* Queue.size(watch.events)) > 0) return false;
                return true;
            });
            const settle = Effect.gen(function* () {
                let stable = 0;
                for (let attempt = 0; attempt < 500; attempt++) {
                    stable = (yield* drained) && (yield* converged) ? stable + 1 : 0;
                    if (stable === 2) return true;
                    yield* Effect.sleep(2);
                }
                return false;
            });
            // Visible rows are confirmed rows plus each prediction reported as applied,
            // and a prediction is reported applied exactly when its row is present.
            const consistent = Effect.gen(function* () {
                const visible = new Map<string, Item>(
                    (yield* replica.confirmed.loadSubset("Item", watched)).map((row) => [
                        String(row.key),
                        { ...(row.value as Item) },
                    ])
                );
                for (const entry of yield* replica.pending) {
                    const id = String(entry.invocation.parameters.id);
                    const present = (yield* replica.get("Item", id)) !== undefined;
                    const base = (yield* replica.confirmed.get("Item", id)) !== undefined;
                    if (entry.prediction !== (base ? "applied" : "dropped")) return false;
                    if (!present && base) return false;
                    const row = visible.get(id);
                    if (row && entry.prediction === "applied") row.value++;
                }
                return (
                    rows(yield* replica.loadSubset("Item", watched)) ===
                    rows([...visible.values()].map((value) => ({ value })))
                );
            });
            let sequence = 0;
            for (const operation of operations) {
                if (operation.kind === "write") {
                    yield* write(
                        operation.id,
                        { id: operation.id, value: operation.value, group: operation.group },
                        operation.report
                    );
                    // A missed change is only recovered by revalidating demanded data, and
                    // so is any change while a crashed watch stays closed.
                    if (operation.report === "missed" || watchers.size === 0)
                        yield* replica.markDemandedStale;
                } else if (operation.kind === "delete") {
                    yield* write(operation.id, undefined, operation.report);
                    if (watchers.size === 0) yield* replica.markDemandedStale;
                } else if (operation.kind === "increment") {
                    // The first prediction must succeed: enqueueing an action for an
                    // object this replica does not have is rejected outright.
                    const known = (yield* replica.get("Item", operation.id)) !== undefined;
                    const enqueued = yield* Effect.result(
                        replica.enqueue({
                            id: `increment-${sequence++}`,
                            name: "increment",
                            parameters: { id: operation.id },
                        })
                    );
                    if ((enqueued._tag === "Success") !== known) return false;
                } else if (operation.kind === "dispatch") yield* Effect.result(replica.syncOnce);
                else if (operation.kind === "expireWatch") {
                    const before = renewals;
                    const expired = [...watchers];
                    // Nothing to expire once a crashed watch has closed for good.
                    if (expired.length === 0) continue;
                    for (const watch of expired)
                        yield* Queue.fail(
                            watch.events,
                            new BackendError({
                                operation: "watch",
                                kind: "Unauthenticated",
                                retryable: false,
                                message: "Token expired.",
                            })
                        );
                    // Changes the closed watch never reports.
                    for (const row of [...server.values()])
                        yield* write(row.id, { ...row, value: row.value + 1 }, "missed");
                    // One renewal for the rejected credential, then the watch reopens.
                    for (
                        let attempt = 0;
                        attempt < 500 && (renewals === before || watchers.size === 0);
                        attempt++
                    )
                        yield* Effect.sleep(2);
                    if (expired.length && renewals !== before + 1) return false;
                    if (watchers.size === 0) return false;
                } else if (operation.kind === "crashWatch") {
                    const crashed = [...watchers];
                    for (const watch of crashed)
                        yield* Queue.failCause(watch.events, Cause.die(new Error("Watch bug.")));
                    for (const row of [...server.values()])
                        yield* write(row.id, { ...row, value: row.value + 1 }, "missed");
                    // A crashed watch must not keep vouching for coverage: it reopens, or
                    // its demand reports the failure (and falls back to age-based reuse).
                    let reported = crashed.length === 0;
                    for (let attempt = 0; attempt < 500 && !reported; attempt++) {
                        yield* Effect.sleep(2);
                        const status = yield* replica.status;
                        reported =
                            watchers.size > 0 ||
                            status.demands.every((demand) => demand.watchError !== undefined);
                    }
                    if (!reported) return false;
                    yield* replica.markDemandedStale;
                } else if (operation.kind === "lostReadBack") {
                    const head = (yield* replica.pending)[0];
                    if (!head) continue;
                    const id = String(head.invocation.parameters.id);
                    const before = (yield* replica.get("Item", id)) as Item | undefined;
                    failReadBack = true;
                    committedSinceFailure = false;
                    yield* Effect.result(replica.syncOnce);
                    failReadBack = false;
                    // The watch has reported the commit; the receipt is not read back yet.
                    yield* Effect.sleep(10);
                    const shown = (yield* replica.get("Item", id)) as Item | undefined;
                    // The commit is not applied on top of the prediction that already shows it.
                    if (
                        committedSinceFailure &&
                        head.prediction === "applied" &&
                        shown?.value !== before?.value
                    )
                        return false;
                    yield* Effect.result(replica.syncOnce);
                } else {
                    const head = (yield* replica.pending)[0];
                    if (!head) continue;
                    const id = String(head.invocation.parameters.id);
                    const slow = {
                        committed: yield* Deferred.make<void>(),
                        release: yield* Deferred.make<void>(),
                    };
                    hold = slow;
                    const before = (yield* replica.get("Item", id)) as Item | undefined;
                    const dispatch = yield* Effect.result(replica.syncOnce).pipe(Effect.forkScoped);
                    const committed = yield* Deferred.await(slow.committed).pipe(
                        Effect.timeout("1 second"),
                        Effect.result
                    );
                    if (committed._tag === "Success") {
                        // Give the watch every chance to apply the commit early.
                        yield* Effect.sleep(10);
                        const shown = (yield* replica.get("Item", id)) as Item | undefined;
                        // Shown once: the prediction on the old base, never on top of the commit.
                        if (head.prediction === "applied" && shown?.value !== before?.value) return false;
                    }
                    yield* Deferred.succeed(slow.release, undefined);
                    yield* Fiber.join(dispatch);
                    hold = undefined;
                }
                if (!(yield* settle)) return false;
                if (!(yield* consistent)) return false;
            }
            // Draining the outbox leaves exactly the source's rows.
            yield* Effect.result(replica.syncOnce);
            yield* Effect.result(replica.syncOnce);
            if (!(yield* settle)) return false;
            return rows(yield* replica.loadSubset("Item", watched)) === expected();
        })
    );

it.live.prop(
    "watch row changes, hints, revalidation and in-flight actions agree with the source oracle",
    [Scenario],
    ([{ operations }]) => run(operations),
    { arbitrary: { runs: 80 }, timeout: 60_000 }
);

it.live("a commit the watch reports before its read-back is not applied on top of its prediction", () =>
    Effect.gen(function* () {
        const agreed = yield* run([
            { kind: "write", id: "i0", value: 1, group: "a", report: "changes" },
            { kind: "increment", id: "i0" },
            { kind: "lostReadBack" },
            { kind: "increment", id: "i0" },
            { kind: "slowDispatch" },
        ]);
        expect(agreed).toBe(true);
    })
);
