import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { makeBlobStorage, byteSource } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { makeNetworkConnectivity, MemoryBlobBytesStore } from "@party-stack/runtime";
import { Effect, Exit, Scope, Stream, Deferred } from "effect";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { expect, test } from "vitest";
import { replicaStateSource } from "./infrastructure.js";
import { makeReplica } from "./service.js";
import type { BackendSubset, OntologyBackendService } from "@party-stack/ontology-backend";
import type { QueryDocument } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "project", displayName: "Project", type: o.string({}) },
                { name: "file", displayName: "File", type: o.optional({ type: o.attachment({}) }) },
            ],
        },
    ],
};
const document = (id: string): QueryDocument => ({
    select: [
        q.sub("projects", {
            from: { source: { objectType: "Project" }, binding: "p" },
            where: q.eq(q.field("p", "id"), q.literal(id)),
            select: [
                q.selectField("id", q.field("p", "id")),
                q.sub("issues", {
                    from: { source: { objectType: "Issue" }, binding: "i" },
                    where: q.eq(q.field("i", "project"), q.field("p", "id")),
                    select: [
                        q.selectField("id", q.field("i", "id")),
                        q.selectField("file", q.field("i", "file")),
                    ],
                }),
            ],
        }),
    ],
});
const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    const connectivity = yield* makeNetworkConnectivity(true);
    const data: Record<string, Record<string, unknown>[]> = {
        Project: [{ id: "a" }, { id: "b" }, { id: "c" }],
        Issue: [
            { id: "one", project: "a", file: { id: "file-a" } },
            { id: "two", project: "b" },
        ],
    };
    const loads: BackendSubset[] = [];
    const backend: OntologyBackendService = {
        name: "fixture",
        sourceId: "fixture",
        supportsIdempotency: false,
        applyAction: () => Effect.die("Unexpected action"),
        queryFunction: () => Effect.void,
        loadSubset: (subset) =>
            Effect.sync(() => {
                loads.push(subset);
                return {
                    complete: true,
                    rows: evaluateQuery(
                        (data[subset.objectType] ?? []).map((value) => ({ key: value.id as string, value })),
                        subset.query
                    ),
                };
            }),
    };
    return { tables, connectivity, data, loads, backend };
});

test("query pins retain a complete graph across replacement, offline edits, restart and clear", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const options = { ...f, namespace: "pins", ir, live: false };
                const firstScope = yield* Scope.make();
                let replica = yield* Scope.provide(makeReplica(options), firstScope);
                yield* replica.demand.setPin(document("a"));
                expect(yield* replica.demand.pinStatus).toMatchObject({ ready: true });
                yield* f.connectivity.set(false);
                yield* replica.demand.setPin(document("b"));
                yield* replica.demand.setPin(document("c"));
                expect(yield* replica.demand.pinStatus).toMatchObject({
                    query: document("c"),
                    ready: false,
                    previousGraphRetained: true,
                });
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeDefined();
                yield* Scope.close(firstScope, Exit.void);
                replica = yield* makeReplica(options);
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeDefined();
                yield* f.connectivity.set(true);
                yield* replica.syncOnce;
                expect(yield* replica.demand.pinStatus).toMatchObject({
                    ready: true,
                    previousGraphRetained: false,
                });
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeUndefined();
                expect(yield* replica.get("Project", "c")).toBeDefined();
                yield* replica.demand.clearPin;
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Project", "c")).toBeUndefined();
                expect(yield* replica.demand.pinStatus).toBeUndefined();
            })
        )
    );
});

test("attachment bytes are opt-in and share the graph's transactional retention", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const blobs = yield* makeBlobStorage({
                    namespace: "pin-blobs",
                    tables: f.tables,
                    bytes: new MemoryBlobBytesStore(),
                });
                let downloads = 0;
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "pin-bytes",
                    ir,
                    live: false,
                    blobs,
                    attachments: {
                        read: () =>
                            Effect.sync(() => {
                                downloads++;
                                return byteSource(new Blob(["content"]));
                            }),
                    },
                });
                yield* replica.demand.setPin(document("a"));
                expect(downloads).toBe(0);
                yield* replica.demand.setPin(document("a"), { attachments: "all" });
                expect(downloads).toBe(1);
                expect(yield* replica.demand.pinStatus).toMatchObject({ ready: true, attachments: "all" });
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                yield* replica.demand.clearPin;
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBeGreaterThan(0);
            })
        )
    );
});

test("replacing a pin cancels its pending acquisition and cannot install the obsolete graph", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const entered = yield* Deferred.make<void>();
                const interrupted = yield* Deferred.make<void>();
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "pin-cancel",
                    ir,
                    objectCacheGc: false,
                    backend: {
                        ...f.backend,
                        loadSubset: (subset) =>
                            JSON.stringify(subset.query).includes('"b"')
                                ? Deferred.succeed(entered, undefined).pipe(
                                      Effect.andThen(Effect.never),
                                      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
                                  )
                                : f.backend.loadSubset(subset),
                    },
                });
                yield* replica.demand.setPin(document("b"));
                yield* Deferred.await(entered);
                yield* replica.demand.setPin(document("c"));
                yield* Deferred.await(interrupted);
                yield* replica.syncOnce;
                expect(yield* replica.demand.pinStatus).toMatchObject({ query: document("c"), ready: true });
                yield* replica.demand.clearPin;
            })
        )
    );
});

test("pinned membership agrees with finite entity recomputation across varied correlations", async () => {
    await fc.assert(
        fc.asyncProperty(fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 12 }), async (projects) => {
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const f = yield* fixture();
                        f.data.Issue = projects.map((project, index) => ({ id: String(index), project }));
                        const owner = yield* Scope.make();
                        let replica = yield* Scope.provide(
                            makeReplica({ ...f, namespace: "pin-oracle", ir, live: false }),
                            owner
                        );
                        const query: QueryDocument = {
                            select: [
                                ...document("a").select,
                                q.sub("other", {
                                    from: { source: { objectType: "Issue" }, binding: "i" },
                                    where: q.eq(q.field("i", "project"), q.literal("b")),
                                    select: [q.selectField("id", q.field("i", "id"))],
                                }),
                            ],
                        };
                        const oracle = yield* executeQuery(query, {
                            reader: {
                                ir,
                                loadSubset: (type, scan) =>
                                    Effect.map(
                                        f.backend.loadSubset({ objectType: type, query: scan }),
                                        (snapshot) => snapshot.rows
                                    ),
                            },
                            mode: "entity",
                            strategy: "reference",
                        });
                        yield* replica.demand.setPin(query);
                        expect(yield* replica.demand.pinStatus).toMatchObject({ ready: true });
                        // Reopen without restoring volatile leases, then compare durable membership.
                        yield* Scope.close(owner, Exit.void);
                        replica = yield* makeReplica({ ...f, namespace: "pin-oracle", ir, live: false });
                        yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                        for (const [type, values] of Object.entries(f.data))
                            for (const value of values)
                                expect(Boolean(yield* replica.get(type, value.id as string))).toBe(
                                    oracle.entities.some(
                                        (entity) => entity.objectType === type && entity.key === value.id
                                    )
                                );
                        for (const entity of oracle.entities)
                            expect(yield* replica.get(entity.objectType, entity.key)).toEqual(entity.value);
                        yield* replica.demand.clearPin;
                        yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                        for (const entity of oracle.entities)
                            expect(yield* replica.get(entity.objectType, entity.key)).toBeUndefined();
                    })
                )
            );
        }),
        { numRuns: 25 }
    );
});

test("coverage age and one-shot mode do not create a hidden polling or outbox lifetime", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                let watches = 0;
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "freshness",
                    ir,
                    live: false,
                    demand: { refresh: { maxCoverageAgeMs: 60_000 } },
                    backend: {
                        ...f.backend,
                        watchSubset: () => {
                            watches++;
                            return Stream.never;
                        },
                    },
                });
                const subset = { from: { source: { objectType: "Project" }, binding: "p" } };
                yield* Effect.scoped(replica.demand.acquire(subset));
                expect(f.loads).toHaveLength(1);
                yield* TestClock.adjust(59_999);
                yield* Effect.scoped(replica.demand.acquire(subset));
                expect(f.loads).toHaveLength(1);
                yield* TestClock.adjust(1);
                yield* Effect.scoped(replica.demand.acquire(subset));
                expect(f.loads).toHaveLength(2);
                expect(watches).toBe(0);
                expect(
                    yield* Effect.result(replica.outbox.enqueue({ id: "no", name: "none", parameters: {} }))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
                expect(Object.keys(replica)).not.toContain("openClient");
                expect(Object.keys(replica)).not.toContain("loadSubset");
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test.each(["committed", "speculative", "snapshot"] as const)(
    "%s delivery updates pinned hierarchical membership",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const authority = yield* makeOwnedBackend({
                        namespace: "authority",
                        ir,
                        tables: yield* Memory.make(),
                        mutators: {},
                    });
                    yield* authority.storage.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* tx.put("Project", { id: "a" });
                            yield* tx.put("Issue", { id: "one", project: "a" });
                            yield* tx.put("Issue", { id: "two", project: "b" });
                        })
                    );
                    const tables = yield* Memory.make();
                    const parent =
                        kind !== "committed"
                            ? yield* makeReplica({
                                  namespace: "parent",
                                  ir,
                                  tables: yield* Memory.make(),
                                  backend: authority,
                                  objectCacheGc: false,
                              })
                            : undefined;
                    const replica = yield* makeReplica({
                        namespace: "membership",
                        ir,
                        tables,
                        objectCacheGc: false,
                        ...(parent
                            ? {
                                  source: {
                                      ...replicaStateSource(parent),
                                      ...(kind === "snapshot" ? { subscribe: undefined } : {}),
                                  },
                              }
                            : { backend: authority }),
                    });
                    const members = Table.make<{ objectType: string; key: string }>({
                        name: JSON.stringify(["replica", "membership", "pins"]),
                    });
                    const waitMembers = (ids: readonly string[]) =>
                        Effect.gen(function* () {
                            for (;;) {
                                const current = (yield* tables.query(members))
                                    .filter((row) => row.value.objectType === "Issue")
                                    .map((row) => row.value.key)
                                    .sort();
                                if (JSON.stringify(current) === JSON.stringify(ids)) return;
                                yield* Effect.sleep(5);
                            }
                        }).pipe(Effect.timeout(3_000));
                    yield* replica.demand.setPin(document("a"));
                    yield* waitMembers(["one"]);
                    yield* authority.storage.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* tx.put("Issue", { id: "one", project: "b" });
                            yield* tx.put("Issue", { id: "two", project: "a" });
                        })
                    );
                    yield* waitMembers(["two"]);
                    expect(yield* replica.demand.pinStatus).toMatchObject({ ready: true });
                    yield* replica.demand.clearPin;
                })
            )
        );
    }
);

test("caller refresh settings override adapter recommendations while healthy watches keep coverage current", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "refresh-defaults",
                    ir,
                    objectCacheGc: false,
                    demand: { refresh: { pollIntervalMs: false, maxCoverageAgeMs: 2_000 } },
                    backend: {
                        ...f.backend,
                        refresh: () => ({ pollIntervalMs: 100, maxCoverageAgeMs: 100 }),
                    },
                });
                const subset = { from: { source: { objectType: "Project" }, binding: "p" } };
                yield* Effect.scoped(replica.demand.acquire(subset));
                yield* TestClock.adjust(1_000);
                yield* Effect.scoped(replica.demand.acquire(subset));
                expect(f.loads).toHaveLength(1);
                yield* TestClock.adjust(1_000);
                yield* Effect.scoped(replica.demand.acquire(subset));
                expect(f.loads).toHaveLength(2);
                const watched = yield* makeReplica({
                    ...f,
                    namespace: "watched-age",
                    ir,
                    objectCacheGc: false,
                    demand: { refresh: { maxCoverageAgeMs: 0 } },
                    backend: { ...f.backend, watchSubset: () => Stream.never },
                });
                const owner = yield* Scope.make();
                yield* Scope.provide(watched.demand.acquire(subset), owner);
                const loads = f.loads.length;
                yield* TestClock.adjust(60_000);
                yield* Scope.provide(watched.demand.acquire(subset), owner);
                expect(f.loads).toHaveLength(loads);
                yield* Scope.close(owner, Exit.void);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("invalid entity projections/options do not replace a pin and unselected attachments are not downloaded", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const replica = yield* makeReplica({ ...f, namespace: "pin-validation", ir, live: false });
                const query: QueryDocument = {
                    select: [
                        q.sub("issues", {
                            from: { source: { objectType: "Issue" }, binding: "i" },
                            select: [q.selectField("id", q.field("i", "id"))],
                        }),
                    ],
                };
                yield* replica.demand.setPin(query, { attachments: "all" });
                expect(yield* replica.demand.pinStatus).toMatchObject({ ready: true });
                const invalid: QueryDocument = {
                    select: [
                        q.sub("issues", {
                            from: { source: { objectType: "Issue" }, binding: "i" },
                            select: [q.selectField("alias", q.field("i", "id"))],
                        }),
                    ],
                };
                expect(yield* Effect.result(replica.demand.setPin(invalid))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidRequest" },
                });
                expect(
                    yield* Effect.result(replica.demand.setPin(query, { attachments: "other" } as never))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidRequest" } });
                expect(yield* replica.demand.pinStatus).toMatchObject({ query, ready: true });
            })
        )
    );
});

test("offset demand loads a prefix once and pins retain it for local evaluation after restart", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                f.data.Issue = [
                    { id: "a", project: "a" },
                    { id: "b", project: "a" },
                    { id: "c", project: "a" },
                ];
                const owner = yield* Scope.make();
                let replica = yield* Scope.provide(
                    makeReplica({ ...f, namespace: "pin-offset", ir, live: false }),
                    owner
                );
                const subset = {
                    from: { source: { objectType: "Issue" }, binding: "i" },
                    orderBy: [{ expression: q.field("i", "id") }],
                    page: { offset: 1, limit: 1 },
                };
                yield* Effect.scoped(replica.demand.acquire(subset));
                expect((yield* replica.readSubset(subset)).map((row) => row.key)).toEqual(["b"]);
                expect(f.loads[0]?.query).toMatchObject({ offset: 0, limit: 2 });
                yield* replica.demand.setPin({
                    select: [
                        q.sub("issues", { ...subset, select: [q.selectField("id", q.field("i", "id"))] }),
                    ],
                });
                expect(yield* replica.demand.pinStatus).toMatchObject({ ready: true });
                yield* Scope.close(owner, Exit.void);
                replica = yield* makeReplica({ ...f, namespace: "pin-offset", ir, live: false });
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect((yield* replica.readSubset(subset)).map((row) => row.key)).toEqual(["b"]);
                yield* replica.demand.clearPin;
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.readSubset(subset)).toEqual([]);
            })
        )
    );
});
