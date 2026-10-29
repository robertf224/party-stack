import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit, Scope } from "effect";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./index.js";
import type { Query } from "@party-stack/ontology-storage";

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
                { name: "group", displayName: "Group", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "put",
            displayName: "Put",
            logic: [],
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "group", displayName: "Group", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
        {
            name: "delete",
            displayName: "Delete",
            logic: [],
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
const execute = Effect.fnUntraced(function* (
    tx: OwnedTransaction,
    action: { name: string; parameters: Record<string, unknown> }
) {
    if (action.name === "delete") yield* tx.delete("Item", action.parameters.id as string);
    else yield* tx.put("Item", action.parameters);
});
const put = (id: string, rank: number, group = "first") => ({
    name: "put",
    id: `put-${id}-${rank}-${group}`,
    parameters: { id, rank, group },
});
const setup = Effect.fnUntraced(function* () {
    const owned = yield* makeOwnedBackend({
        namespace: "owned",
        ir,
        tables: yield* Memory.make(),
        mutators: { put: execute, delete: execute },
    });
    yield* owned.applyAction(put("a", 1));
    yield* owned.applyAction(put("b", 2));
    yield* owned.applyAction(put("c", 3));
    yield* owned.applyAction(put("z", 0, "second"));
    const parent = yield* makeReplica({
        namespace: "parent",
        ir,
        tables: yield* Memory.make(),
        backend: owned,
        execute,
        startSync: false,
        outbox: { retryDelayMs: 0 },
        gc: false,
    });
    yield* parent.demand({ objectType: "Item" });
    yield* parent.syncOnce;
    const child = yield* makeReplica({
        namespace: "child",
        ir,
        tables: yield* Memory.make(),
        source: replicaStateSource(parent),
        execute,
        startSync: false,
        outbox: { retryDelayMs: 0 },
    });
    return { owned, parent, child };
});
const keys = (rows: readonly { key: string | number }[]) =>
    rows.map((row) => row.key).sort((a, b) => String(a).localeCompare(String(b)));
const window: Query = { where: eq(field("group"), "first"), orderBy: [{ field: field("rank") }], limit: 2 };

test("forwarding an unchanged query preserves its parent demand and coverage identity", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { parent, child } = yield* setup();
                yield* child.demand({ objectType: "Item" });
                expect((yield* parent.status).demands).toHaveLength(1);
                expect((yield* parent.status).demands[0]?.references).toBe(2);
                const query = { where: eq(field("group"), "first") };
                yield* child.demand({ objectType: "Item", query });
                yield* parent.syncOnce;
                const parentDemand = (yield* parent.status).demands.find((demand) => demand.query?.where);
                expect(parentDemand?.query).toEqual(query);
                expect(parentDemand?.coveredBy).toEqual({ objectType: "Item", query: {} });
                expect(parentDemand?.coverageProof?.reason).toBe("collection");
            })
        )
    );
});

test("partial state follows the composed top-k window without copying the source collection or its outbox", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                yield* f.child.demand({ objectType: "Item", query: window });
                yield* f.child.syncOnce;
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a", "b"]);
                yield* f.parent.enqueue(put("a", 10));
                yield* f.child.syncOnce;
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["b", "c"]);
                yield* f.parent.enqueue(put("b", 2, "second"));
                yield* f.child.syncOnce;
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a", "c"]);
                expect((yield* f.child.get("Item", "a"))?.rank).toBe(10);
                expect((yield* f.child.confirmed.get("Item", "a"))?.rank).toBe(1);
                expect((yield* f.child.parentState)?.pending).toEqual([]);
                // A duplicate selected snapshot may arrive in query order rather than key order.
                yield* f.child.syncOnce;
                yield* f.parent.enqueue({ id: "delete-c", name: "delete", parameters: { id: "c" } });
                yield* f.child.syncOnce;
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a"]);
                expect(yield* f.parent.pending).toHaveLength(3);
                const mirrored = (yield* f.child.parentState)!;
                expect(mirrored.objects[0]?.base).toHaveLength(1);
                expect(mirrored.objects[0]?.overrides).toHaveLength(1);
                yield* f.child.retainActions([put("a", 10).id]);
                yield* f.child.syncOnce;
                expect((yield* f.child.parentState)?.pending.map((entry) => entry.invocation.id)).toEqual([
                    put("a", 10).id,
                ]);
            })
        )
    );
});

test("membership changes at the same source revision are fenced and old views cannot overwrite them", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const child = yield* makeReplica({
                    namespace: "views",
                    ir,
                    tables: yield* Memory.make(),
                    source: f.owned.protocol,
                    execute,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    gc: false,
                });
                const first = yield* Scope.make();
                yield* Scope.provide(child.retainLocal("Item", window), first);
                yield* child.syncOnce;
                const old = (yield* child.parentState)!;
                yield* Scope.close(first, Exit.void);
                yield* child.retainLocal("Item", { where: eq(field("group"), "second") });
                yield* child.syncOnce;
                const current = (yield* child.parentState)!;
                expect(current.revision).toBe(old.revision);
                expect(current.view!.generation).toBeGreaterThan(old.view!.generation);
                expect(keys(yield* child.loadSubset("Item"))).toEqual(["z"]);
                yield* child.receiveParentState(old);
                expect(keys(yield* child.loadSubset("Item"))).toEqual(["z"]);
            })
        )
    );
});

test("the owned source also transfers only selected rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const child = yield* makeReplica({
                    namespace: "direct",
                    ir,
                    tables: yield* Memory.make(),
                    source: f.owned.protocol,
                    execute,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    gc: false,
                });
                yield* child.retainLocal("Item", window);
                yield* child.syncOnce;
                expect(keys(yield* child.loadSubset("Item"))).toEqual(["a", "b"]);
                expect((yield* child.parentState)?.objects[0]?.base).toHaveLength(2);
                expect(yield* child.get("Item", "z")).toBeUndefined();
            })
        )
    );
});

test("pending-action row dependencies survive releasing UI demand without pinning unrelated rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const upstream = replicaStateSource(f.parent);
                let online = false;
                const source = {
                    ...upstream,
                    submit: (request: Parameters<typeof upstream.submit>[0]) =>
                        online
                            ? upstream.submit(request)
                            : Effect.fail(
                                  new BackendError({
                                      operation: "test",
                                      kind: "Unavailable",
                                      message: "Offline.",
                                      retryable: true,
                                  })
                              ),
                };
                const child = yield* makeReplica({
                    namespace: "offline",
                    ir,
                    tables: yield* Memory.make(),
                    source,
                    execute,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    gc: false,
                });
                const reader = yield* Scope.make();
                yield* Scope.provide(child.demand({ objectType: "Item", query: window }), reader);
                yield* child.syncOnce;
                yield* child.enqueue(put("z", 9, "second"));
                expect((yield* Effect.result(child.syncOnce))._tag).toBe("Failure");
                yield* Scope.close(reader, Exit.void);
                yield* child.refreshParent(source);
                expect(keys(yield* child.loadSubset("Item"))).toEqual(["z"]);
                expect((yield* child.confirmed.get("Item", "z"))?.rank).toBe(0);
                expect((yield* child.get("Item", "z"))?.rank).toBe(9);
                expect(yield* f.parent.pending).toEqual([]);
                online = true;
                yield* child.syncOnce;
                expect(yield* child.pending).toEqual([]);
                expect((yield* child.actionStatus(put("z", 9, "second").id)).parentAcceptance).toBeDefined();
                yield* f.parent.syncOnce;
                yield* child.syncOnce;
                expect((yield* child.receipt(put("z", 9, "second").id))?.outcome).toBe("committed");
                // Last-read data is now eligible for ordinary GC, not an active dependency.
                expect(yield* child.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(yield* child.loadSubset("Item")).toEqual([]);
            })
        )
    );
});

test("protocol GC evicts one logical base and can reload the identical parent revision", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                yield* f.parent.enqueue(put("a", 10));
                yield* f.parent.enqueue(put("new", 4));
                yield* f.parent.enqueue({ id: "delete-z", name: "delete", parameters: { id: "z" } });
                const snapshot = yield* f.parent.snapshotState;
                yield* f.child.receiveParentState(snapshot);
                const reader = yield* Scope.make();
                yield* Scope.provide(
                    f.child.retainLocal("Item", {
                        where: eq(field("group"), "first"),
                        orderBy: [{ field: field("rank") }],
                        limit: 1,
                    }),
                    reader
                );
                yield* f.child.pin("Item", "new", true);
                // 'a' is first in confirmed base; 'b' is first in parent-visible base.
                expect(yield* f.child.collectGarbage({ olderThanMs: 0 })).toBe(2);
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a", "b", "new"]);
                expect((yield* f.child.confirmed.get("Item", "a"))?.rank).toBe(1);
                expect((yield* f.child.get("Item", "a"))?.rank).toBe(10);
                yield* Scope.close(reader, Exit.void);
                yield* f.child.pin("Item", "new", false);
                expect(yield* f.child.collectGarbage({ olderThanMs: 0 })).toBe(3);
                expect(yield* f.child.loadSubset("Item")).toEqual([]);
                expect((yield* f.child.parentState)?.objects[0]?.overrides).toEqual([]);
                // A local rebase cannot resurrect the parent's evicted overrides.
                yield* f.child.enqueue(put("own", 7));
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["own"]);
                // Eviction must not disable reused-revision corruption checks.
                const conflicting = {
                    ...snapshot,
                    objects: snapshot.objects.map((object) => ({ ...object, base: [] })),
                };
                const conflict = yield* Effect.result(f.child.receiveParentState(conflicting));
                expect(conflict._tag).toBe("Failure");
                if (conflict._tag === "Failure") expect(conflict.failure.kind).toBe("Conflict");
                yield* f.child.receiveParentState(snapshot);
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a", "b", "c", "new", "own"]);
                expect((yield* f.child.get("Item", "a"))?.rank).toBe(10);
                expect((yield* f.child.confirmed.get("Item", "a"))?.rank).toBe(1);
            })
        )
    );
});

test("protocol GC retains action dependencies after parent inclusion until final reconciliation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                const reader = yield* Scope.make();
                yield* Scope.provide(f.child.retainLocal("Item"), reader);
                yield* f.child.syncOnce;
                yield* f.child.enqueue(put("a", 10));
                yield* f.child.syncOnce;
                expect(yield* f.child.pending).toEqual([]); // Accepted, not a second action to submit.
                expect((yield* f.child.actionStatus(put("a", 10).id)).parentAcceptance).toBeDefined();
                yield* Scope.close(reader, Exit.void);
                expect(yield* f.child.collectGarbage({ olderThanMs: 0 })).toBe(3);
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a"]);
                expect((yield* f.child.get("Item", "a"))?.rank).toBe(10);
                expect((yield* f.child.confirmed.get("Item", "a"))?.rank).toBe(1);
                // The dependency stays in the selected read even without a UI query.
                yield* f.child.syncOnce;
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a"]);
                expect((yield* f.child.snapshotState).pending[0]).not.toHaveProperty("includedInBase");
                yield* f.parent.syncOnce;
                yield* f.child.syncOnce;
                expect((yield* f.child.actionStatus(put("a", 10).id)).receipt?.outcome).toBe("committed");
                expect(yield* f.child.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(yield* f.child.loadSubset("Item")).toEqual([]);
            })
        )
    );
});

test("protocol window retention imports the offset prefix and keeps explicit pins in its selection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                yield* f.child.retainLocal("Item", { ...window, offset: 1, limit: 1 });
                yield* f.child.pin("Item", "z", true);
                yield* f.child.syncOnce;
                expect(keys(yield* f.child.loadSubset("Item"))).toEqual(["a", "b", "z"]);
                expect(keys(yield* f.child.loadSubset("Item", { ...window, offset: 1, limit: 1 }))).toEqual([
                    "b",
                ]);
                expect(yield* f.child.collectGarbage({ olderThanMs: 0 })).toBe(0);
                yield* f.child.pin("Item", "z", false);
                expect(yield* f.child.collectGarbage({ olderThanMs: 0 })).toBe(1);
            })
        )
    );
});

test("protocol base preserves encrypted caches without mixing confirmed and inherited row values", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const definition: OntologyIR = {
                    ...ir,
                    objectTypes: ir.objectTypes.map((type) => ({
                        ...type,
                        properties: [
                            ...type.properties,
                            {
                                name: "secret",
                                displayName: "Secret",
                                type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                            },
                        ],
                    })),
                };
                const value = {
                    ciphertext: "remote-1",
                    source: { objectType: "Item", primaryKey: "a", property: "secret" },
                };
                const local = { ciphertext: "local-1" };
                const owned = yield* makeOwnedBackend({
                    namespace: "secret-source",
                    ir: definition,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* owned.storage.transaction((tx) =>
                    tx.put("Item", { id: "a", group: "first", rank: 1, secret: value })
                );
                const child = yield* makeReplica({
                    namespace: "secret-child",
                    ir: definition,
                    tables: yield* Memory.make(),
                    source: owned.protocol,
                    execute,
                    startSync: false,
                });
                yield* child.retainLocal("Item");
                yield* child.syncOnce;
                yield* child.encryptedCache.put(value, local);
                const snapshot = (yield* child.parentState)!;
                const inherited = {
                    ...snapshot,
                    revision: snapshot.revision + 1,
                    objects: [
                        {
                            ...snapshot.objects[0]!,
                            overrides: [
                                {
                                    key: "a",
                                    value: {
                                        deleted: false as const,
                                        value: { id: "a", group: "first", rank: 10, secret: value },
                                    },
                                },
                            ],
                        },
                    ],
                };
                yield* child.receiveParentState(inherited);
                expect((yield* child.confirmed.get("Item", "a"))?.rank).toBe(1);
                expect((yield* child.get("Item", "a"))?.rank).toBe(10);
                expect(yield* child.encryptedCache.get(value)).toEqual(local);
                // Repeated parent publication preserves a device copy in the inherited layer.
                yield* child.receiveParentState({ ...inherited, revision: inherited.revision + 1 });
                expect(yield* child.encryptedCache.get(value)).toEqual(local);
                const updated = { ...value, ciphertext: "remote-2" };
                yield* child.receiveParentState({
                    ...inherited,
                    revision: inherited.revision + 2,
                    objects: [
                        {
                            ...inherited.objects[0]!,
                            overrides: [
                                {
                                    key: "a",
                                    value: {
                                        deleted: false,
                                        value: { id: "a", group: "first", rank: 11, secret: updated },
                                    },
                                },
                            ],
                        },
                    ],
                });
                expect(yield* child.encryptedCache.get(value)).toBeUndefined();
                expect(yield* child.encryptedCache.get(updated)).toBeUndefined();
                yield* child.encryptedCache.put(updated, { ciphertext: "local-2" });
                expect(yield* child.encryptedCache.get(updated)).toEqual({ ciphertext: "local-2" });
                expect((yield* child.confirmed.get("Item", "a"))?.rank).toBe(1);
                expect(yield* child.collectGarbage({ olderThanMs: 0 })).toBe(0);
            })
        )
    );
});
