import * as PgClient from "@effect/sql-pg/PgClient";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Table, field } from "@party-stack/ontology-storage/tables";
import { Deferred, Effect, Exit, Fiber, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { expect, inject, test } from "vitest";
import { make } from "./tables.js";

const url = inject("postgresUrl");
const layer = () => PgClient.layer({ url: Redacted.make(url), maxConnections: 12 });
const prefix = () => `pg_test_${crypto.randomUUID().replaceAll("-", "")}`;
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.scoped));

test("native PostgreSQL ranks and windows each partition independently", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const rows = Table.make<{ group: string; n: number }>({ name: "partitioned" });
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    for (let n = 0; n < 20; n++)
                        yield* tx.put(rows, String(n), { group: n % 2 ? "b" : "a", n });
                    for (const name of ["group", "n"])
                        yield* tx.ensureIndex(rows, { name, field: field(name) });
                })
            );
            const selected = yield* tables.read((tx) =>
                tx.queryGrouped!(rows, field("group"), {
                    orderBy: [{ field: field("n"), direction: "desc" }],
                    offset: 1,
                    limit: 2,
                })
            );
            expect(selected?.map((row) => row.value.n).sort((a, b) => a - b)).toEqual([14, 15, 16, 17]);
        })
    );
});

test("independent writers overlap and a read transaction keeps its snapshot without blocking writes", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const rows = Table.make<number>({ name: "values" });
            yield* tables.put(rows, "a", 0);
            yield* tables.put(rows, "b", 0);
            const ready = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const entered = new Set<string>();
            const write = (id: string) =>
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        const value = yield* tx.get(rows, id);
                        entered.add(id);
                        if (entered.size === 2) yield* Deferred.succeed(ready, undefined);
                        yield* Deferred.await(release);
                        yield* tx.put(rows, id, value! + 1);
                    })
                );
            const writers = yield* Effect.forkChild(
                Effect.all([write("a"), write("b")], { concurrency: "unbounded" })
            );
            yield* Deferred.await(ready).pipe(
                Effect.timeout("3 seconds"),
                Effect.ensuring(Deferred.succeed(release, undefined))
            );
            yield* Fiber.join(writers);
            expect(yield* tables.get(rows, "a")).toBe(1);
            expect(yield* tables.get(rows, "b")).toBe(1);

            const snapshotReady = yield* Deferred.make<void>();
            const updated = yield* Deferred.make<void>();
            const snapshot = yield* Effect.forkChild(
                tables.read((tx) =>
                    Effect.gen(function* () {
                        expect(yield* tx.get(rows, "a")).toBe(1);
                        yield* Deferred.succeed(snapshotReady, undefined);
                        yield* Deferred.await(updated);
                        expect(yield* tx.get(rows, "a")).toBe(1);
                    })
                )
            );
            yield* Deferred.await(snapshotReady);
            yield* tables
                .put(rows, "a", 2)
                .pipe(Effect.timeout("3 seconds"), Effect.ensuring(Deferred.succeed(updated, undefined)));
            yield* Fiber.join(snapshot);
            expect(yield* tables.get(rows, "a")).toBe(2);
        })
    );
});

test("write-intent reads preserve increments and predicate coordination prevents write skew", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const rows = Table.make<number>({ name: "counter" });
            yield* tables.put(rows, "value", 0);
            let attempts = 0;
            yield* Effect.all(
                Array.from({ length: 8 }, () =>
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            attempts++;
                            const value = yield* tx.get(rows, "value", { forUpdate: true });
                            yield* Effect.sleep("3 millis");
                            yield* tx.put(rows, "value", value! + 1);
                        })
                    )
                ),
                { concurrency: "unbounded" }
            );
            expect(yield* tables.get(rows, "value")).toBe(8);
            expect(attempts).toBe(8);
            const shifts = Table.make<{ active: boolean }>({ name: "shifts" });
            yield* tables.put(shifts, "a", { active: true });
            yield* tables.put(shifts, "b", { active: true });
            yield* Effect.all(
                ["a", "b"].map((id) =>
                    tables.transaction((tx) =>
                        Effect.gen(function* () {
                            const active = yield* tx.query(shifts, {
                                where: { op: "eq", left: field("active"), right: true },
                            });
                            yield* Effect.sleep("5 millis");
                            if (active.length > 1) yield* tx.put(shifts, id, { active: false });
                        })
                    )
                ),
                { concurrency: "unbounded" }
            );
            expect((yield* tables.query(shifts)).filter((row) => row.value.active)).toHaveLength(1);
        })
    );
}, 30000);

test("only confirmed transaction aborts retry; caught SQL failures still roll back", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const sql = yield* SqlClient.SqlClient;
            const rows = Table.make<number>({ name: "errors" });
            let attempts = 0;
            const failed = yield* Effect.exit(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        attempts++;
                        yield* tx.put(rows, "before", 1);
                        // The native statement failure is caught by the caller; COMMIT must still fail.
                        yield* Effect.exit(
                            tx.put(rows, Array.from({ length: 1000 }, () => crypto.randomUUID()).join(""), 2)
                        );
                    })
                )
            );
            expect(Exit.isFailure(failed)).toBe(true);
            expect(attempts).toBe(1);
            expect(yield* tables.get(rows, "before")).toBeUndefined();
            let aborts = 0;
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    if (aborts++ === 0)
                        yield* sql.unsafe(
                            "DO $$ BEGIN RAISE EXCEPTION 'test rollback' USING ERRCODE = '40001'; END $$"
                        );
                    yield* tx.put(rows, "after", 3);
                })
            );
            expect(aborts).toBe(2);
            expect(yield* tables.get(rows, "after")).toBe(3);
        })
    );
});

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            logic: [],
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};

test("owned journal follows publication order, supports snapshot catch-up, and deduplicates concurrent actions", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let parallelAttempts = 0;
            const backend = yield* makeOwnedBackend({
                namespace: "owned",
                tables,
                ir,
                history: { maxCommits: Infinity },
                mutators: {
                    increment: (tx: OwnedTransaction, request) =>
                        Effect.gen(function* () {
                            const id = request.parameters.id as string;
                            if (id.startsWith("parallel-")) {
                                parallelAttempts++;
                                yield* Effect.sleep("10 millis");
                            }
                            const previous = yield* tx.get("Counter", id);
                            yield* tx.put("Counter", { id, count: Number(previous?.count ?? 0) + 1 });
                            if (id === "slow") {
                                yield* Deferred.succeed(started, undefined);
                                yield* Deferred.await(release);
                            }
                        }),
                },
            });
            const slow = yield* Effect.forkChild(
                backend.applyAction({ id: "slow-op", name: "increment", parameters: { id: "slow" } })
            );
            yield* Deferred.await(started);
            const fast = yield* backend
                .applyAction({ id: "fast-op", name: "increment", parameters: { id: "fast" } })
                .pipe(
                    Effect.timeout("3 seconds"),
                    Effect.onError(() => Deferred.succeed(release, undefined))
                );
            const snapshot = yield* backend.loadSubset({ objectType: "Counter" });
            expect(snapshot.rows.map((row) => row.key)).toEqual(["fast"]);
            yield* Deferred.succeed(release, undefined);
            const late = yield* Fiber.join(slow);
            expect(JSON.parse(late.cursor!).revision).toBeGreaterThan(JSON.parse(fast.cursor!).revision);
            const catchup = yield* backend.changes!.pull({ cursor: snapshot.cursor });
            expect(catchup.commits.map((commit) => commit.operationId)).toEqual(["slow-op"]);
            const action = { id: "duplicate", name: "increment", parameters: { id: "same" } };
            const [first, second] = yield* Effect.all(
                [backend.applyAction(action), backend.applyAction(action)],
                { concurrency: "unbounded" }
            );
            expect(first).toEqual(second);
            expect(
                (yield* backend.loadSubset({ objectType: "Counter" })).rows.find((row) => row.key === "same")
                    ?.value.count
            ).toBe(1);
            yield* backend.storage.transaction((tx) =>
                Effect.forEach(
                    Array.from({ length: 16 }, (_, i) => `parallel-${i}`),
                    (id) => tx.put("Counter", { id, count: 0 }),
                    { discard: true }
                )
            );
            yield* Effect.all(
                Array.from({ length: 16 }, (_, i) =>
                    backend.applyAction({
                        id: `parallel-op-${i}`,
                        name: "increment",
                        parameters: { id: `parallel-${i}` },
                    })
                ),
                { concurrency: 8 }
            );
            expect(parallelAttempts).toBe(16);
            const rows = (yield* backend.loadSubset({ objectType: "Counter" })).rows;
            expect(
                rows.filter((row) => String(row.key).startsWith("parallel-") && row.value.count === 1)
            ).toHaveLength(16);
        })
    );
}, 15000);

test("publication coordination lasts until commit and rollback gaps cannot hide a later commit", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const rows = Table.make<number>({ name: "published" });
            yield* tables.put(rows, "seed", 0);
            const allocated = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const first = yield* Effect.forkChild(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put(rows, "first", 1);
                        const revision = yield* tx.allocateRevision("stream");
                        yield* Deferred.succeed(allocated, undefined);
                        yield* Deferred.await(release);
                        return revision;
                    })
                )
            );
            yield* Deferred.await(allocated);
            const second = yield* Effect.forkChild(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put(rows, "second", 2);
                        return yield* tx.allocateRevision("stream");
                    })
                )
            );
            yield* Effect.sleep("30 millis");
            expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["seed"]);
            yield* Deferred.succeed(release, undefined);
            const revisions = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
            expect(revisions[1]).toBeGreaterThan(revisions[0]!);
            const aborted = yield* Effect.exit(
                tables.transaction((tx) =>
                    Effect.andThen(tx.allocateRevision("stream"), Effect.fail("abort after allocation"))
                )
            );
            expect(Exit.isFailure(aborted)).toBe(true);
            expect(yield* tables.allocateRevision("stream")).toBeGreaterThan(revisions[1]! + 1);
        })
    );
});

test("a lost COMMIT reply never replays a transaction that already committed", async () => {
    await run(
        Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const withTransaction: SqlClient.SqlClient["withTransaction"] = (body) =>
                sql.withTransaction(body).pipe(
                    Effect.andThen(
                        Effect.fail(
                            new SqlError({
                                reason: new ConnectionError({ cause: new Error("lost COMMIT reply") }),
                            })
                        )
                    )
                );
            const client: SqlClient.SqlClient = new Proxy(sql, {
                get: (target, property) =>
                    property === "withTransaction"
                        ? withTransaction
                        : property === "withoutTransforms"
                          ? () => client
                          : Reflect.get(target, property),
            });
            const physicalPrefix = prefix();
            const tables = yield* make({ prefix: physicalPrefix }).pipe(
                Effect.provideService(SqlClient.SqlClient, client)
            );
            const rows = Table.make<number>({ name: "uncertain" });
            let attempts = 0;
            const result = yield* Effect.exit(
                tables.transaction((tx) => {
                    attempts++;
                    return tx.put(rows, "committed", 1);
                })
            );
            expect(Exit.isFailure(result)).toBe(true);
            expect(attempts).toBe(1);
            expect(
                yield* sql`SELECT data FROM ${sql(`${physicalPrefix}_rows`)} WHERE table_name=${rows.name}`
            ).toHaveLength(1);
        })
    );
});

test("actual cross-key deadlocks restart the complete database transaction", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const rows = Table.make<number>({ name: "deadlock" });
            yield* tables.put(rows, "a", 0);
            yield* tables.put(rows, "b", 0);
            const ready = yield* Deferred.make<void>();
            const entered = new Set<string>();
            let attempts = 0;
            const update = (first: string, second: string) =>
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        attempts++;
                        yield* tx.get(rows, first, { forUpdate: true });
                        entered.add(first);
                        if (entered.size === 2) yield* Deferred.succeed(ready, undefined);
                        yield* Deferred.await(ready);
                        const other = yield* tx.get(rows, second, { forUpdate: true });
                        yield* tx.put(rows, second, other! + 1);
                    })
                );
            yield* Effect.all([update("a", "b"), update("b", "a")], { concurrency: "unbounded" });
            expect(attempts).toBeGreaterThan(2);
            expect(yield* tables.get(rows, "a")).toBe(1);
            expect(yield* tables.get(rows, "b")).toBe(1);
        })
    );
}, 15000);

test("journal compaction preserves the head after all entries expire", async () => {
    await run(
        Effect.gen(function* () {
            const tables = yield* make({ prefix: prefix() });
            const backend = yield* makeOwnedBackend({
                namespace: "expiring",
                ir,
                tables,
                history: { maxAgeMs: 0, maxCommits: 2 },
                mutators: {
                    increment: (tx, request) => tx.put("Counter", { id: request.parameters.id, count: 1 }),
                },
            });
            let revision = 0;
            for (let i = 0; i < 4; i++) {
                const receipt = yield* backend.applyAction({
                    id: `op-${i}`,
                    name: "increment",
                    parameters: { id: `row-${i}` },
                });
                const next = JSON.parse(receipt.cursor!).revision as number;
                expect(next).toBeGreaterThan(revision);
                revision = next;
                const snapshot = yield* backend.loadSubset({ objectType: "Counter" });
                expect(JSON.parse(snapshot.cursor!).revision).toBe(revision);
                expect((yield* backend.changes!.pull({ cursor: snapshot.cursor })).commits).toEqual([]);
            }
        })
    );
});
