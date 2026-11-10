import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { makeBlobStorage, byteSource } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { makeNetworkConnectivity, MemoryBlobBytesStore, RuntimeError } from "@party-stack/runtime";
import { Effect, Exit, Scope, Stream, Deferred, Schema, PubSub } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeReplicaKernel } from "./engine.js";
import { replicaStateSource } from "./infrastructure.js";
import { pinRecordKey } from "./pinModel.js";
import { makeQueryPin } from "./pins.js";
import { makeReplica } from "./service.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
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
    const loads: CompiledSubset[] = [];
    const backend: OntologyBackendService = makeOntologyBackend({
        ir,
        name: "fixture",
        sourceId: "fixture",
        supportsIdempotency: false,
        applyAction: () => Effect.die("Unexpected action"),
        queryFunction: () => Effect.void,
        loadSubset: (request) =>
            Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                Effect.sync(() => {
                    loads.push(subset);
                    return {
                        complete: true,
                        rows: evaluateQuery(
                            (data[subset.objectType] ?? []).map((value) => ({
                                key: value.id as string,
                                value,
                            })),
                            subset.query
                        ),
                    };
                })
            ),
    });
    return { tables, network: connectivity, data, loads, backend };
});

test("capacity estimates are live diagnostics and a failed sensor does not stop replica status", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                let availableBytes = 2048;
                const replica = yield* makeReplica({
                    namespace: "capacity",
                    ir,
                    tables: f.tables,
                    backend: f.backend,
                    capacity: {
                        memory: Effect.fail(
                            new RuntimeError({
                                operation: "capacity.memory",
                                cause: "private sensor details",
                            })
                        ),
                        storage: Effect.sync(() => ({ scope: "filesystem", availableBytes })),
                    },
                });
                const status = yield* replica.status.get;
                expect(status.capacity).toEqual({
                    memory: undefined,
                    memoryError: "Memory estimate unavailable.",
                    storage: { scope: "filesystem", availableBytes: 2048 },
                    storageError: undefined,
                });
                expect(JSON.stringify(status)).not.toContain("private sensor details");
                availableBytes = 1024;
                expect((yield* replica.status.get).capacity?.storage?.availableBytes).toBe(1024);
            })
        )
    );
});

test("named pins keep overlapping graphs across removal and resume every revision", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const options = { ...f, namespace: "plural-pins", ir, live: false };
                const firstScope = yield* Scope.make();
                let replica = yield* Scope.provide(makeReplica(options), firstScope);
                const folderA = { name: "folders", query: document("a") };
                const overlapping = { name: "favorites", query: document("a") };
                const folderB = { name: "folders", query: document("b") };
                yield* replica.demand.pins.update({ set: [folderA, overlapping, folderB] });
                const first = yield* replica.demand.pins.list;
                expect(first).toHaveLength(3);
                expect(first.every((row) => row.ready)).toBe(true);
                yield* replica.demand.pins.set(folderA);
                expect(
                    (yield* replica.demand.pins.list).find((row) => row.id === pinRecordKey(folderA))
                        ?.generation
                ).toBe(first.find((row) => row.id === pinRecordKey(folderA))?.generation);
                yield* replica.demand.pins.remove(pinRecordKey(folderA));
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeDefined();
                expect(yield* replica.get("Issue", "two")).toBeDefined();
                yield* Scope.close(firstScope, Exit.void);
                replica = yield* makeReplica(options);
                expect(yield* replica.demand.pins.list).toHaveLength(2);
                yield* replica.demand.pins.clear("folders");
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeDefined();
                expect(yield* replica.get("Issue", "two")).toBeUndefined();
                yield* replica.demand.pins.clear("favorites");
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeUndefined();
                expect(yield* replica.demand.pins.list).toEqual([]);
            })
        )
    );
});

test("named downloads resume from offline intent in a one-shot background sync", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.network.set(false);
                const options = { ...f, namespace: "plural-background", ir, live: false };
                const scope = yield* Scope.make();
                let replica = yield* Scope.provide(makeReplica(options), scope);
                yield* replica.demand.pins.set({ name: "folders", query: document("a") });
                expect(yield* replica.demand.pins.list).toMatchObject([{ ready: false }]);
                yield* Scope.close(scope, Exit.void);
                replica = yield* makeReplica(options);
                yield* f.network.set(true);
                yield* replica.syncOnce;
                expect(yield* replica.demand.pins.list).toMatchObject([{ ready: true }]);
                expect(yield* replica.get("Issue", "one")).toBeDefined();
            })
        )
    );
});

test("overlapping named downloads retain shared bytes until the last owner is removed", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const blobs = yield* makeBlobStorage({
                    namespace: "plural-bytes",
                    tables: f.tables,
                    bytes: new MemoryBlobBytesStore(),
                });
                let downloads = 0;
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "plural-bytes",
                    ir,
                    live: false,
                    blobs,
                    attachments: {
                        read: () =>
                            Effect.sync(() => {
                                downloads++;
                                return byteSource(new Blob(["shared bytes"]));
                            }),
                    },
                });
                const a = { name: "folders", query: document("a"), attachments: "all" as const };
                const b = { ...a, name: "favorites" };
                yield* replica.demand.pins.update({ set: [a, b] });
                expect(downloads).toBe(1);
                yield* replica.demand.pins.remove(pinRecordKey(a));
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                expect(yield* replica.demand.pins.list).toMatchObject([{ name: "favorites", ready: true }]);
                yield* replica.demand.pins.remove(pinRecordKey(b));
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBeGreaterThan(0);
            })
        )
    );
});

test("a plural pin update validates all intents atomically before acquisition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const replica = yield* makeReplica({ ...f, namespace: "plural-invalid", ir, live: false });
                const result = yield* Effect.result(
                    replica.demand.pins.update({
                        set: [
                            { name: "folders", query: document("a") },
                            {
                                name: "invalid",
                                query: {
                                    select: [
                                        q.sub("bad", {
                                            from: { source: { objectType: "Missing" }, binding: "bad" },
                                            select: [],
                                        }),
                                    ],
                                },
                            },
                        ],
                    })
                );
                expect(result._tag).toBe("Failure");
                expect(yield* replica.demand.pins.list).toEqual([]);
                expect(f.loads).toEqual([]);
            })
        )
    );
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
                expect((yield* replica.demand.pinStatus)?.retainedGraph).toBeUndefined();
                yield* f.network.set(false);
                yield* replica.demand.setPin(document("b"));
                yield* replica.demand.setPin(document("c"));
                expect(yield* replica.demand.pinStatus).toMatchObject({
                    query: document("c"),
                    ready: false,
                    previousGraphRetained: true,
                    retainedGraph: { query: document("a"), attachments: "none" },
                });
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeDefined();
                yield* Scope.close(firstScope, Exit.void);
                replica = yield* makeReplica(options);
                expect((yield* replica.demand.pinStatus)?.retainedGraph).toMatchObject({
                    query: document("a"),
                });
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeDefined();
                yield* f.network.set(true);
                yield* replica.syncOnce;
                expect(yield* replica.demand.pinStatus).toMatchObject({
                    ready: true,
                    previousGraphRetained: false,
                });
                expect((yield* replica.demand.pinStatus)?.retainedGraph).toBeUndefined();
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

test("refreshing an unchanged pin graph preserves its membership rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const roots = Table.make({ name: JSON.stringify(["replica", "stable-pins", "pins"]) });
                let writes = 0;
                const tables: typeof f.tables = {
                    ...f.tables,
                    transaction: (body) =>
                        f.tables.transaction((tx) =>
                            body({
                                ...tx,
                                put: (table, key, value) => {
                                    if (table.name === roots.name) writes++;
                                    return tx.put(table, key, value);
                                },
                                delete: (table, key) => {
                                    if (table.name === roots.name) writes++;
                                    return tx.delete(table, key);
                                },
                                clear: (table) => {
                                    if (table.name === roots.name) writes++;
                                    return tx.clear(table);
                                },
                            })
                        ),
                };
                const replica = yield* makeReplica({
                    ...f,
                    tables,
                    namespace: "stable-pins",
                    ir,
                    live: false,
                });
                yield* replica.demand.setPin(document("a"));
                const before = yield* tables.query(roots);
                expect(before.length).toBeGreaterThan(0);
                writes = 0;
                yield* replica.demand.setPin(document("a"));
                expect(writes).toBe(0);
                expect(yield* tables.query(roots)).toEqual(before);
                yield* replica.demand.setPin(document("b"));
                expect(writes).toBeGreaterThan(0);
                yield* replica.collectGarbage({ minUnusedAgeMs: 0 });
                expect(yield* replica.get("Issue", "one")).toBeUndefined();
                expect(yield* replica.get("Issue", "two")).toBeDefined();
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
                    cache: { objects: false },
                    backend: {
                        ...f.backend,
                        loadSubset: (request) =>
                            Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                                JSON.stringify(subset.query).includes('"b"')
                                    ? Deferred.succeed(entered, undefined).pipe(
                                          Effect.andThen(Effect.never),
                                          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
                                      )
                                    : f.backend.loadSubset(request)
                            ),
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

it.effect("incomplete pin coverage stays pending beyond five seconds and resumes on notification", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const engine = yield* makeReplicaKernel({
                ...f,
                namespace: "pin-pending",
                ir,
                execute: () => Effect.void,
                startSync: false,
                objectCacheGc: false,
            });
            const updates = yield* PubSub.sliding<void>(1);
            const waiting = yield* Deferred.make<void>();
            let complete = false;
            // Reproduce a persisted failure from the former coverage deadline.
            yield* f.tables.put(
                Table.make({ name: JSON.stringify(["replica", "pin-pending", "query-pin"]) }),
                "head",
                {
                    desired: { query: document("a"), generation: "existing" },
                    error: { kind: "Unavailable", message: "Waiting for coverage" },
                }
            );
            const pin = yield* makeQueryPin({
                ...f,
                namespace: "pin-pending",
                ir,
                live: true,
                engine: {
                    ...engine,
                    demand: () => Effect.void,
                    syncSubset: () => Effect.void,
                    hasCoverage: () => Effect.succeed(complete),
                    snapshotSubset: () =>
                        Deferred.succeed(waiting, undefined).pipe(Effect.as({ complete, rows: [] })),
                    subscribeChanges: Effect.map(PubSub.subscribe(updates), Stream.fromSubscription),
                    visibleChanges: Effect.succeed(Stream.never),
                },
            });
            yield* Deferred.await(waiting);
            yield* TestClock.adjust(60_000);
            expect(yield* pin.pinStatus).toMatchObject({ ready: false, error: undefined });
            complete = true;
            yield* PubSub.publish(updates, undefined);
            yield* pin.refresh;
            expect(yield* pin.pinStatus).toMatchObject({ ready: true, error: undefined });
        })
    )
);

it.effect("pin commands accept newer intent while obsolete acquisition cleanup is held", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const engine = yield* makeReplicaKernel({
                ...f,
                namespace: "pin-command",
                ir,
                execute: () => Effect.void,
                startSync: false,
                objectCacheGc: false,
            });
            const waiting = yield* Deferred.make<void>();
            const cleanup = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const pin = yield* makeQueryPin({
                ...f,
                namespace: "pin-command",
                ir,
                live: true,
                engine: {
                    ...engine,
                    demand: (subset) =>
                        JSON.stringify(subset.query).includes('"b"')
                            ? Effect.addFinalizer(() =>
                                  Deferred.succeed(cleanup, undefined).pipe(
                                      Effect.andThen(Deferred.await(release))
                                  )
                              )
                            : Effect.void,
                    syncSubset: () => Effect.void,
                    hasCoverage: () => Effect.succeed(true),
                    snapshotSubset: (subset) =>
                        Deferred.succeed(waiting, undefined).pipe(
                            Effect.as({ complete: !JSON.stringify(subset.query).includes('"b"'), rows: [] })
                        ),
                    subscribeChanges: Effect.succeed(Stream.never),
                    visibleChanges: Effect.succeed(Stream.never),
                },
            });
            try {
                yield* pin.setPin(document("b"));
                yield* Deferred.await(waiting);
                yield* pin.setPin(document("c"));
                yield* Deferred.await(cleanup);
                // Neither clearing nor another set waits for the held finalizer.
                yield* pin.clearPin();
                expect(yield* pin.pinStatus).toBeUndefined();
                yield* pin.setPin(document("a"));
                expect(yield* pin.pinStatus).toMatchObject({ query: document("a"), ready: false });
            } finally {
                yield* Deferred.succeed(release, undefined);
            }
            yield* Effect.all([pin.setPin(document("b")), pin.clearPin(), pin.setPin(document("a"))], {
                concurrency: "unbounded",
            });
            yield* pin.refresh;
            expect(yield* pin.pinStatus).toMatchObject({ query: document("a"), ready: true });
        })
    )
);

it.live.prop(
    "pinned membership agrees with finite entity recomputation across varied correlations",
    [Schema.Array(Schema.Literals(["a", "b", "c"])).check(Schema.isMaxLength(12))],
    ([projects]) =>
        Effect.gen(function* () {
            yield* Effect.scoped(
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
                                    f.backend.loadSubset(objectSubset(type, scan)),
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
            );
        }),
    { arbitrary: { runs: 25 } }
);

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
                            return Effect.succeed(Stream.never);
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
                                  cache: { objects: false },
                              })
                            : undefined;
                    const replica = yield* makeReplica({
                        namespace: "membership",
                        ir,
                        tables,
                        cache: { objects: false },
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
                    cache: { objects: false },
                    demand: { refresh: { pollIntervalMs: false, maxCoverageAgeMs: 2_000 } },
                    backend: {
                        ...f.backend,
                        refresh: () => ({ pollIntervalMs: 100, maxCoverageAgeMs: 100 }),
                    },
                });
                const subset = { from: { source: { objectType: "Project" }, binding: "p" } };
                yield* Effect.scoped(replica.demand.acquire(subset, { resultType: "complete" }));
                yield* TestClock.adjust(1_000);
                yield* Effect.scoped(replica.demand.acquire(subset, { resultType: "complete" }));
                expect(f.loads).toHaveLength(1);
                yield* TestClock.adjust(1_000);
                yield* Effect.scoped(replica.demand.acquire(subset, { resultType: "complete" }));
                expect(f.loads).toHaveLength(2);
                const watched = yield* makeReplica({
                    ...f,
                    namespace: "watched-age",
                    ir,
                    cache: { objects: false },
                    demand: { refresh: { maxCoverageAgeMs: 0 } },
                    backend: { ...f.backend, watchSubset: () => Effect.succeed(Stream.never) },
                });
                const owner = yield* Scope.make();
                yield* Scope.provide(watched.demand.acquire(subset, { resultType: "complete" }), owner);
                const loads = f.loads.length;
                yield* TestClock.adjust(60_000);
                yield* Scope.provide(watched.demand.acquire(subset, { resultType: "complete" }), owner);
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

test("object cache budgets override age but never evict the pinned graph", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "budget-pins",
                    ir,
                    live: false,
                    cache: { objects: { maxBytes: 1, targetBytes: 0 } },
                });
                yield* Effect.scoped(
                    replica.demand.acquire({ from: { source: { objectType: "Project" }, binding: "p" } })
                );
                yield* replica.demand.setPin(document("a"));
                yield* replica.collectGarbage();
                expect(yield* replica.get("Project", "a")).toBeDefined();
                expect(yield* replica.get("Project", "b")).toBeUndefined();
                expect((yield* replica.status.get).cache?.objects.bytes).toBeGreaterThan(1);
                yield* replica.demand.clearPin;
                yield* replica.collectGarbage();
                expect((yield* replica.status.get).cache?.objects.bytes).toBe(0);
            })
        )
    );
});

test("cache pressure releases idle demand before reclaiming its rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const replica = yield* makeReplica({
                    ...f,
                    namespace: "budget-idle",
                    ir,
                    live: false,
                    demand: { idleRetentionMs: 60_000 },
                    cache: { objects: { maxBytes: 1, targetBytes: 0 } },
                });
                yield* Effect.scoped(
                    replica.demand.acquire({ from: { source: { objectType: "Project" }, binding: "p" } })
                );
                expect((yield* replica.status.get).demands).toHaveLength(1);
                yield* replica.collectGarbage();
                expect((yield* replica.status.get).demands).toEqual([]);
                expect((yield* replica.status.get).cache?.objects.bytes).toBe(0);
            })
        )
    );
});
