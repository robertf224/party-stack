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
    yield* owned.invoke(put("a", 1));
    yield* owned.invoke(put("b", 2));
    yield* owned.invoke(put("c", 3));
    yield* owned.invoke(put("z", 0, "second"));
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
        gc: false,
    });
    return { owned, parent, child };
});
const keys = (rows: readonly { key: string | number }[]) =>
    rows.map((row) => row.key).sort((a, b) => String(a).localeCompare(String(b)));
const window: Query = { where: eq(field("group"), "first"), orderBy: [{ field: field("rank") }], limit: 2 };

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
                expect(yield* child.loadSubset("Item")).toEqual([]);
            })
        )
    );
});
