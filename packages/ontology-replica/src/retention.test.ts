import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { eq, field, gte } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Scope, Exit, Result } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplica } from "./index.js";
import type { ReplicaOptions } from "./index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: ["write", "queued"].map((name) => ({ name, displayName: name, parameters: [], logic: [] })),
    objectTypes: [
        {
            name: "Row",
            displayName: "Row",
            pluralDisplayName: "Rows",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
};
const setup = Effect.fnUntraced(function* (execute: ReplicaOptions["execute"] = () => Effect.void) {
    const tables = yield* Memory.make();
    const server = yield* makeOwnedBackend({
        namespace: "retention-server",
        ir,
        tables: yield* Memory.make(),
        mutators: {
            write: (tx, action) =>
                tx.put("Row", { id: action.parameters.id, count: action.parameters.count }),
        },
    });
    let sequence = 0;
    const put = (id: string, count: number) =>
        server.applyAction({ id: `seed-${sequence++}`, name: "write", parameters: { id, count } });
    for (let i = 0; i < 5; i++) yield* put(`row${i}`, i);
    const options: ReplicaOptions = {
        namespace: "retention-local",
        ir,
        tables,
        execute,
        startSync: false,
        backend: {
            ...server,
            applyAction: () =>
                Effect.fail(
                    new BackendError({
                        operation: "test",
                        kind: "Unavailable",
                        message: "Keep pending while pulling changes",
                        retryable: true,
                    })
                ),
        },
    };
    const replica = yield* makeReplica(options);
    yield* replica.syncOnce;
    return { replica, options, tables, put };
});

test("overlapping demands retain only their rows and the prefix influencing a bounded window", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica } = yield* setup();
                const window = yield* Scope.make();
                yield* Scope.provide(
                    replica.demand({
                        objectType: "Row",
                        query: {
                            where: gte(field("count"), 1),
                            orderBy: [{ field: field("count"), direction: "desc" }],
                            offset: 1,
                            limit: 1,
                        },
                    }),
                    window
                );
                yield* replica.demand({ objectType: "Row", query: { where: eq(field("id"), "row0") } });
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(2);
                expect((yield* replica.loadSubset("Row")).map((row) => row.key)).toEqual([
                    "row0",
                    "row3",
                    "row4",
                ]);
                yield* Scope.close(window, Exit.void);
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(2);
                expect((yield* replica.loadSubset("Row")).map((row) => row.key)).toEqual(["row0"]);
            })
        )
    );
});

test("persisted-only reader roots are precise across contexts", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica, options } = yield* setup();
                const other = yield* makeReplica(options);
                yield* other.retainLocal("Row", { where: eq(field("id"), "row2") });
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(4);
                expect((yield* other.loadSubset("Row")).map((row) => row.key)).toEqual(["row2"]);
            })
        )
    );
});

test("pending point reads and write targets survive GC without retaining unrelated rows, including after restart", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica, options } = yield* setup((tx) =>
                    Effect.gen(function* () {
                        const source = yield* tx.get("Row", "row1");
                        yield* tx.put("Row", { id: "row3", count: Number(source?.count ?? 0) + 10 });
                    })
                );
                yield* replica.enqueue({ id: "offline", name: "queued", parameters: {} });
                const reopened = yield* makeReplica(options);
                expect(yield* reopened.collectGarbage({ minUnusedAgeMs: 0 })).toBe(3);
                expect((yield* reopened.confirmed.loadSubset("Row")).map((row) => row.key)).toEqual([
                    "row1",
                    "row3",
                ]);
                expect((yield* reopened.get("Row", "row3"))?.count).toBe(11);
                yield* reopened.remove("offline");
                expect(yield* reopened.collectGarbage({ minUnusedAgeMs: 0 })).toBe(2);
            })
        )
    );
});

test("sync ingestion and dependency replacement commit together while an outbox action remains pending", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica, put } = yield* setup((tx) =>
                    Effect.gen(function* () {
                        const rows = yield* tx.loadSubset("Row", {
                            where: gte(field("count"), 3),
                            orderBy: [{ field: field("count"), direction: "desc" }],
                            limit: 1,
                        });
                        yield* tx.put("Row", { id: "derived", count: Number(rows[0]?.value.count ?? 0) });
                    })
                );
                yield* replica.enqueue({ id: "pending", name: "queued", parameters: {} });
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(4);
                yield* put("new-source", 8);
                yield* put("unrelated", 0);
                const dispatch = yield* Effect.result(replica.syncOnce);
                expect(Result.isFailure(dispatch) && dispatch.failure.kind).toBe("Unavailable");
                expect((yield* replica.get("Row", "derived"))?.count).toBe(8);
                expect((yield* replica.pending)[0]?.state).toBe("queued");
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(2);
                expect((yield* replica.confirmed.loadSubset("Row")).map((row) => row.key)).toEqual([
                    "new-source",
                ]);
                expect((yield* replica.get("Row", "derived"))?.count).toBe(8);
            })
        )
    );
});

test("blocked replays keep previous dependencies, partial reads, and newly matching query rows", async () => {
    let fail = false;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica, put } = yield* setup((tx) =>
                    Effect.gen(function* () {
                        yield* tx.get("Row", fail ? "row2" : "row1");
                        yield* tx.loadSubset("Row", { where: eq(field("count"), 9) });
                        if (fail)
                            return yield* new BackendError({
                                operation: "test",
                                kind: "ValidationFailed",
                                message: "Blocked",
                                retryable: false,
                            });
                    })
                );
                yield* replica.enqueue({ id: "blocked", name: "queued", parameters: {} });
                fail = true;
                yield* put("trigger", 0);
                yield* replica.syncOnce;
                expect((yield* replica.pending)[0]?.state).toBe("blocked");
                yield* put("phantom", 9);
                yield* replica.syncOnce;
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(4);
                expect((yield* replica.loadSubset("Row")).map((row) => row.key)).toEqual([
                    "phantom",
                    "row1",
                    "row2",
                ]);
                yield* replica.remove("blocked");
                expect(yield* replica.collectGarbage({ minUnusedAgeMs: 0 })).toBe(3);
            })
        )
    );
});

test("automatic bounded collection belongs to the replica scope and preserves a narrow demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { options } = yield* setup();
                let transactions = 0;
                const owner = yield* Scope.make();
                const replica = yield* Scope.provide(
                    makeReplica({
                        ...options,
                        startSync: true,
                        pollIntervalMs: 1_000_000,
                        objectCacheGc: { sweepIntervalMs: 10, minUnusedAgeMs: 0, maxCandidates: 2 },
                        tables: {
                            ...options.tables,
                            transaction: (body) =>
                                Effect.suspend(() => {
                                    transactions++;
                                    return options.tables.transaction(body);
                                }),
                        },
                    }),
                    owner
                );
                yield* Scope.provide(replica.retainLocal("Row", { where: eq(field("id"), "row0") }), owner);
                yield* TestClock.adjust(100);
                expect((yield* replica.loadSubset("Row")).map((row) => row.key)).toEqual(["row0"]);
                yield* Scope.close(owner, Exit.void);
                const closedAt = transactions;
                yield* TestClock.adjust(30);
                expect(transactions).toBe(closedAt);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("owner restart discards abandoned query leases while retaining pins and pending action dependencies", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const oldScope = yield* Scope.fork(yield* Effect.scope);
                const { replica, tables, options } = yield* Scope.provide(
                    setup((tx) => tx.get("Row", "row1").pipe(Effect.asVoid)),
                    oldScope
                );
                yield* replica.pin("Row", "row0", true);
                yield* replica.enqueue({ id: "pending", name: "queued", parameters: {} });
                yield* Scope.close(oldScope, Exit.void);
                // A process crash cannot execute finalizers. Seed the persisted lease it leaves behind.
                const roots = Table.make<{ owner: string; objectType: string; kind: "remote"; query: {} }>({
                    name: JSON.stringify(["replica", options.namespace, "roots"]),
                });
                yield* tables.put(roots, "old-query", {
                    owner: "previous-process",
                    objectType: "Row",
                    kind: "remote",
                    query: {},
                });
                const reopened = yield* makeReplica(options);
                expect(yield* tables.query(roots)).toEqual([]);
                expect(yield* reopened.collectGarbage({ minUnusedAgeMs: 0 })).toBe(3);
                expect((yield* reopened.loadSubset("Row")).map((row) => row.key)).toEqual(["row0", "row1"]);
                expect((yield* reopened.pending).map((entry) => entry.invocation.id)).toEqual(["pending"]);
            })
        )
    );
});
