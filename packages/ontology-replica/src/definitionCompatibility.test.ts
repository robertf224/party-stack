import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { ConfigurationError, OntologyStorageError, Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplica } from "./testing.js";
import type { ReplicaOptions } from "./testing.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const definition = (label: string, countType = o.integer({})): OntologyIR => ({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: label,
            pluralDisplayName: label,
            primaryKey: "id",
            color: label,
            properties: [
                { name: "id", displayName: label, type: o.string({}) },
                { name: "count", displayName: label, type: countType },
            ],
        },
    ],
    actionTypes: [{ name: "write", displayName: label, parameters: [], logic: [] }],
});

test("cosmetic definition updates preserve rows, coverage, pin retention and queued intent across owner restart", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition("Old");
                const tables = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "definition-source",
                    tables: yield* Memory.make(),
                    mutators: {
                        write: (tx, action) =>
                            tx.put("Item", { id: action.parameters.id, count: action.parameters.count }),
                    },
                });
                yield* backend.applyAction({
                    id: "seed",
                    name: "write",
                    parameters: { id: "item", count: 1 },
                });
                const owner = yield* Scope.fork(yield* Effect.scope);
                const options: ReplicaOptions = {
                    ir,
                    tables,
                    namespace: "definition-cache",
                    backend,
                    startSync: false,
                    execute: (tx) => tx.put("Item", { id: "item", count: 2 }),
                };
                const original = yield* Scope.provide(makeReplica(options), owner);
                yield* Scope.provide(original.demand({ objectType: "Item" }), owner);
                yield* original.syncSubset({ objectType: "Item" });
                yield* original.pin("Item", "item", true);
                yield* original.enqueue({ id: "offline", name: "write", parameters: {} });
                const sourceId = original.sourceId;
                yield* Scope.close(owner, Exit.void);

                const reopenedScope = yield* Scope.fork(yield* Effect.scope);
                const reopened = yield* Scope.provide(
                    makeReplica({ ...options, ir: definition("New") }),
                    reopenedScope
                );
                expect(reopened.sourceId).toBe(sourceId);
                expect(yield* reopened.loadSubset("Item")).toEqual([
                    { key: "item", value: { id: "item", count: 2 } },
                ]);
                expect((yield* reopened.pending).map((entry) => entry.invocation.id)).toEqual(["offline"]);
                // An optimistic write legitimately marks freshness stale; its
                // historical complete proof must still survive the rename.
                const coverage = Table.make<{ complete?: boolean }>({
                    name: JSON.stringify(["replica", "definition-cache", "coverage"]),
                });
                expect((yield* tables.query(coverage)).some((row) => row.value.complete)).toBe(true);
                expect(yield* reopened.collectGarbage({ minUnusedAgeMs: 0 })).toBe(0);
                yield* Scope.close(reopenedScope, Exit.void);

                // A genuine contract change must not reinterpret the retained data or
                // erase the pending invocation when acquisition fails.
                const changed = definition("New");
                changed.objectTypes[0]!.properties[1]!.type = o.string({});
                expect(yield* Effect.result(makeReplica({ ...options, ir: changed }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                const preserved = yield* makeReplica({ ...options, ir: definition("Newest") });
                expect((yield* preserved.pending).map((entry) => entry.invocation.id)).toEqual(["offline"]);
                expect((yield* preserved.loadSubset("Item"))[0]?.value.count).toBe(2);
            })
        )
    );
});

test("reopened replicas keep the full definition signature that app storage migrations compare", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition("Persisted");
                const tables = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "persisted-source",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const options: ReplicaOptions = {
                    ir,
                    tables,
                    namespace: "persisted-cache",
                    backend,
                    startSync: false,
                    execute: () => Effect.void,
                };
                const head = Table.make<{ signature: string }>({
                    name: JSON.stringify(["replica", "persisted-cache", "position"]),
                });
                // Applications such as Notes migrate this head by comparing it with
                // ontologyDefinitionSignature before the replica opens.
                for (let launch = 0; launch < 3; launch++) {
                    const scope = yield* Scope.fork(yield* Effect.scope);
                    yield* Scope.provide(makeReplica(options), scope);
                    yield* Scope.close(scope, Exit.void);
                    expect((yield* tables.get(head, "head"))!.signature).toBe(
                        ontologyDefinitionSignature(ir)
                    );
                }
            })
        )
    );
});

test("a definition reset keeps queued actions and replays their predictions against the new definition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition("Old");
                const tables = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "reset-source",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* backend.applyAction({ id: "seed", name: "write", parameters: {} }).pipe(Effect.ignore);
                const options: ReplicaOptions = {
                    ir,
                    tables,
                    namespace: "reset-cache",
                    backend,
                    startSync: false,
                    execute: (tx) => tx.put("Item", { id: "item", count: 2 }),
                };
                const owner = yield* Scope.fork(yield* Effect.scope);
                const original = yield* Scope.provide(makeReplica(options), owner);
                yield* original.enqueue({ id: "offline", name: "write", parameters: {} });
                expect((yield* original.loadSubset("Item"))[0]?.value.count).toBe(2);
                yield* Scope.close(owner, Exit.void);

                const changed = definition("New");
                changed.objectTypes[0]!.properties[1]!.type = o.string({});
                const outbox = Table.make<{ prediction?: string }>({
                    name: JSON.stringify(["replica", "reset-cache", "outbox"]),
                });
                // The old action writes an integer where the new definition has a string: its
                // prediction no longer applies, so it is dropped, but the action stays queued.
                const reset = yield* Scope.fork(yield* Effect.scope);
                const dropped = yield* Scope.provide(
                    makeReplica({ ...options, ir: changed, onDefinitionChange: "reset" }),
                    reset
                );
                expect((yield* dropped.pending).map((entry) => entry.invocation.id)).toEqual(["offline"]);
                expect((yield* tables.get(outbox, "offline"))?.prediction).toBe("dropped");
                expect(yield* dropped.loadSubset("Item")).toEqual([]);
                yield* Scope.close(reset, Exit.void);

                // An action that still fits the new definition is predicted again.
                const replayed = yield* makeReplica({
                    ...options,
                    ir: changed,
                    onDefinitionChange: "reset",
                    execute: (tx) => tx.put("Item", { id: "item", count: "two" }),
                });
                expect((yield* replayed.pending).map((entry) => entry.invocation.id)).toEqual(["offline"]);
                expect((yield* tables.get(outbox, "offline"))?.prediction).toBe("applied");
                expect(yield* replayed.loadSubset("Item")).toEqual([
                    { key: "item", value: { id: "item", count: "two" } },
                ]);
            })
        )
    );
});

test("a reset rolls back with a failed open, a changed source is refused, an unreadable stored definition resets everything, and a new primary key opens", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition("Old");
                const storage = yield* Memory.make();
                // Fail index setup while the replica opens, when asked, to force a rollback.
                let failIndexes = false;
                const tables: typeof storage = {
                    ...storage,
                    transaction: (body) =>
                        storage.transaction((tx) =>
                            body({
                                ...tx,
                                ensureIndex: (table, index) =>
                                    failIndexes
                                        ? Effect.fail(
                                              new OntologyStorageError({
                                                  operation: "test",
                                                  reason: new ConfigurationError({
                                                      message: "Index setup failed.",
                                                  }),
                                              })
                                          )
                                        : tx.ensureIndex(table, index),
                            })
                        ),
                };
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "rollback-source",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const options: ReplicaOptions = {
                    ir,
                    tables,
                    namespace: "rollback-cache",
                    backend,
                    startSync: false,
                    execute: () => Effect.void,
                };
                const open = (overrides: Partial<ReplicaOptions>) =>
                    Effect.scoped(makeReplica({ ...options, ...overrides } as ReplicaOptions)).pipe(
                        Effect.asVoid
                    );
                yield* open({});
                const position = Table.make<{ source: string; signature: string }>({
                    name: JSON.stringify(["replica", "rollback-cache", "position"]),
                });
                const rows = Table.make<{ id: string; count: number }>({
                    name: JSON.stringify(["replica", "rollback-cache", "base:Item"]),
                });
                const head = (yield* tables.get(position, "head"))!;
                yield* tables.put(rows, "item", { id: "item", count: 1 });

                // The reset runs in the startup transaction: when opening fails after it, the
                // reset rolls back too and the old cache stays as it was.
                const rekeyed = definition("New");
                rekeyed.objectTypes[0]!.primaryKey = "count";
                failIndexes = true;
                expect(
                    yield* Effect.result(open({ ir: rekeyed, onDefinitionChange: "reset" }))
                ).toMatchObject({ _tag: "Failure" });
                failIndexes = false;
                expect(yield* tables.get(position, "head")).toEqual(head);
                expect(yield* tables.get(rows, "item")).toEqual({ id: "item", count: 1 });

                // A different source is never reset into.
                const changed = definition("New");
                changed.objectTypes[0]!.properties[1]!.type = o.string({});
                expect(
                    yield* Effect.result(
                        open({
                            ir: changed,
                            onDefinitionChange: "reset",
                            backend: { ...backend, sourceId: "other" },
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "SourceMismatch" } });
                expect(yield* tables.get(rows, "item")).toEqual({ id: "item", count: 1 });

                // A stored definition that can no longer be read cannot be compared, so everything resets.
                yield* tables.put(position, "head", { ...head, signature: "unreadable" });
                yield* open({ onDefinitionChange: "reset" });
                expect(yield* tables.get(rows, "item")).toBeUndefined();
                expect((yield* tables.get(position, "head"))?.signature).toBe(head.signature);

                // A new primary key opens: the reset drops the type's old indexes, including the
                // unique primary-key index, and opening ensures them on the new field.
                yield* tables.put(rows, "item", { id: "item", count: 1 });
                yield* open({ ir: rekeyed, onDefinitionChange: "reset" });
                expect(yield* tables.get(rows, "item")).toBeUndefined();
                const indexes = yield* storage.read((tx) => tx.indexes(rows));
                expect(indexes.find((index) => index.name === "primaryKey")?.field.path).toEqual(["count"]);
            })
        )
    );
});
