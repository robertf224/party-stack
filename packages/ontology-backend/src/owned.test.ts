import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { OntologyStorageError, SchemaMismatch } from "@party-stack/ontology-storage";
import { byteSource } from "@party-stack/ontology-storage/blobs";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Result, Deferred, Fiber } from "effect";
import { expect, test } from "vitest";
import { makeOwnedBackend, type OwnedTransaction } from "./owned.js";
import { BackendError } from "./index.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Counter", "Other"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: name,
        primaryKey: "id",
        properties: [
            { name: "id", displayName: "Id", type: o.string({}) },
            { name: "count", displayName: "Count", type: o.integer({}) },
        ],
    })),
    actionTypes: ["increment", "fail"].map((name) => ({
        name,
        displayName: name,
        logic: [],
        parameters: [
            { name: "id", displayName: "Id", type: o.string({}) },
            { name: "amount", displayName: "Amount", type: o.integer({}) },
        ],
    })),
};
const rejected = () =>
    new BackendError({
        operation: "applyAction",
        kind: "ValidationFailed",
        message: "Expected rejection",
        retryable: false,
    });

test("owned commits atomically persist rows, receipts, and ordered source-scoped change batches", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            let escaped: OwnedTransaction | undefined;
            const options = {
                namespace: "owned-test",
                ir,
                tables,
                mutators: {
                    increment: (tx: OwnedTransaction, action: { parameters: Record<string, unknown> }) =>
                        Effect.gen(function* () {
                            escaped = tx;
                            const id = action.parameters.id as string;
                            const previous = yield* tx.get("Counter", id);
                            yield* tx.put("Counter", {
                                id,
                                count: Number(previous?.count ?? 0) + Number(action.parameters.amount),
                            });
                            const ownWrite = yield* tx.get("Counter", id);
                            expect(ownWrite?.count).toBe(
                                Number(previous?.count ?? 0) + Number(action.parameters.amount)
                            );
                        }),
                    fail: (tx: OwnedTransaction) =>
                        Effect.gen(function* () {
                            yield* tx.put("Counter", { id: "rollback", count: 99 });
                            yield* tx.put("Other", { id: "rollback", count: 99 });
                            return yield* rejected();
                        }),
                },
            };
            const backend = yield* makeOwnedBackend(options);
            const invocation = { id: "one", name: "increment", parameters: { id: "counter", amount: 1 } };
            const receipt = yield* backend.applyAction(invocation);
            expect(receipt.outcome).toBe("committed");
            expect(
                yield* backend.applyAction({ ...invocation, parameters: { amount: 1, id: "counter" } })
            ).toEqual(receipt);
            const reopened = yield* makeOwnedBackend(options);
            expect(yield* reopened.applyAction(invocation)).toEqual(receipt);
            expect(Result.isFailure(yield* Effect.result(escaped!.get("Counter", "counter")))).toBe(true);
            const conflict = yield* Effect.result(
                backend.applyAction({ ...invocation, parameters: { id: "counter", amount: 2 } })
            );
            expect(Result.isFailure(conflict) && conflict.failure.kind).toBe("Conflict");
            const snapshot = yield* backend.loadSubset({ objectType: "Counter" });
            expect(snapshot.rows).toEqual([{ key: "counter", value: { id: "counter", count: 1 } }]);
            expect(snapshot.cursor).toBe(receipt.cursor);
            const failed = yield* Effect.result(
                backend.applyAction({ id: "failed", name: "fail", parameters: { id: "ignored", amount: 1 } })
            );
            expect(Result.isFailure(failed)).toBe(true);
            expect((yield* backend.loadSubset({ objectType: "Other" })).rows).toEqual([]);
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows).toEqual(snapshot.rows);
            const all = yield* backend.changes!.pull({});
            expect(all.commits).toEqual([
                {
                    cursor: receipt.cursor,
                    operationId: "one",
                    changes: [
                        {
                            kind: "put",
                            objectType: "Counter",
                            key: "counter",
                            value: { id: "counter", count: 1 },
                        },
                    ],
                },
            ]);
            expect((yield* backend.changes!.pull({ cursor: snapshot.cursor })).commits).toEqual([]);
            const invalid = yield* Effect.result(
                backend.changes!.pull({ cursor: JSON.stringify({ source: "other", revision: 1 }) })
            );
            expect(Result.isFailure(invalid) && invalid.failure.kind).toBe("SourceMismatch");
        })
    );
});

test("concurrent actions read their transaction state and journal pagination never skips commits", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const backend = yield* makeOwnedBackend({
                namespace: "concurrent",
                ir,
                tables,
                mutators: {
                    increment: (tx, action) =>
                        Effect.gen(function* () {
                            const previous = yield* tx.get("Counter", action.parameters.id as string);
                            yield* Effect.yieldNow;
                            yield* tx.put("Counter", {
                                id: action.parameters.id,
                                count: Number(previous?.count ?? 0) + 1,
                            });
                        }),
                },
            });
            yield* Effect.all(
                Array.from({ length: 12 }, (_, index) =>
                    backend.applyAction({
                        id: `invocation-${index}`,
                        name: "increment",
                        parameters: { id: "shared", amount: 1 },
                    })
                ),
                { concurrency: "unbounded" }
            );
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(12);
            let cursor: string | undefined;
            const ids: string[] = [];
            do {
                const page = yield* backend.changes!.pull({ cursor, limit: 3 });
                ids.push(...page.commits.map((commit) => commit.operationId!));
                cursor = page.cursor;
                if (!page.hasMore) break;
            } while (true);
            expect(new Set(ids).size).toBe(12);
            expect(ids).toHaveLength(12);
        })
    );
});

test("owned action transactions reject uploads collected before commit and retain uploads committed first", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const values = new Map<string, Blob>();
                const blobs = yield* makeBlobStorage({
                    namespace: "owned-uploads",
                    tables,
                    mode: "authoritative",
                    bytes: {
                        read: (key) =>
                            Effect.sync(() => {
                                const value = values.get(key);
                                return value === undefined ? undefined : byteSource(value);
                            }),
                        write: (key, value) =>
                            collectByteBlob(value).pipe(
                                Effect.map((blob) => {
                                    values.set(key, blob);
                                })
                            ),
                        delete: (key) =>
                            Effect.sync(() => {
                                values.delete(key);
                            }),
                    },
                });
                const definition: OntologyIR = {
                    ...ir,
                    objectTypes: [
                        {
                            name: "Asset",
                            displayName: "Asset",
                            pluralDisplayName: "Assets",
                            primaryKey: "id",
                            properties: [
                                { name: "id", displayName: "ID", type: o.string({}) },
                                { name: "photo", displayName: "Photo", type: o.attachment({}) },
                            ],
                        },
                    ],
                    actionTypes: [
                        {
                            name: "create",
                            displayName: "Create",
                            logic: [],
                            parameters: [
                                { name: "id", displayName: "ID", type: o.string({}) },
                                { name: "photo", displayName: "Photo", type: o.attachment({}) },
                            ],
                        },
                    ],
                };
                const uploaded = yield* Deferred.make<void>();
                const finish = yield* Deferred.make<void>();
                const backend = yield* makeOwnedBackend({
                    namespace: "owned-uploads",
                    ir: definition,
                    tables,
                    blobs,
                    prepareUploads: () =>
                        Effect.gen(function* () {
                            yield* blobs.stage("photo", new Blob(["keep"]));
                            yield* Deferred.succeed(uploaded, undefined);
                            yield* Deferred.await(finish);
                            return Effect.void;
                        }).pipe(Effect.mapError(() => rejected())),
                    mutators: { create: (tx, invocation) => tx.put("Asset", invocation.parameters) },
                });
                const action = yield* Effect.forkScoped(
                    Effect.result(
                        backend.applyAction({
                            id: "action",
                            name: "create",
                            parameters: {
                                id: "asset",
                                photo: { id: "photo" },
                            },
                            attachmentUploads: [
                                { attachment: { id: "photo" }, blob: new Blob(["keep"]), target: {} },
                            ],
                        })
                    )
                );
                yield* Deferred.await(uploaded);
                // Upload preparation is outside the action transaction. An expired orphan
                // may legitimately disappear before the action establishes its references.
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                yield* Deferred.succeed(finish, undefined);
                const collectedFirst = yield* Fiber.join(action);
                expect(Result.isFailure(collectedFirst)).toBe(true);
                expect((yield* backend.loadSubset({ objectType: "Asset" })).rows).toEqual([]);
                expect(yield* blobs.metadata("photo")).toBeUndefined();
                // No successful receipt was recorded: the same invocation can upload again.
                const committedFirst = yield* backend.applyAction({
                    id: "action",
                    name: "create",
                    parameters: { id: "asset", photo: { id: "photo" } },
                    attachmentUploads: [
                        { attachment: { id: "photo" }, blob: new Blob(["keep"]), target: {} },
                    ],
                });
                expect(committedFirst.outcome).toBe("committed");
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                expect(values.size).toBe(1);
                expect((yield* blobs.read("photo"))?.size).toBe(4);
            })
        )
    );
});

test("trusted integrations share the action journal and preserve callback errors on rollback", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const backend = yield* makeOwnedBackend({
                namespace: "trusted-integration",
                ir,
                tables,
                mutators: {},
            });
            const before = yield* backend.loadSubset({ objectType: "Counter" });
            const value = yield* backend.storage.transaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.put("Counter", { id: "one", count: 1 });
                    yield* tx.put("Counter", { id: "one", count: 2 });
                    yield* tx.put("Other", { id: "two", count: 3 });
                    return "return value";
                })
            );
            expect(value).toBe("return value");
            const page = yield* backend.changes!.pull({ cursor: before.cursor });
            expect(page.commits).toHaveLength(1);
            expect(page.commits[0]?.operationId).toBeUndefined();
            expect(page.commits[0]?.changes).toEqual([
                { kind: "put", objectType: "Counter", key: "one", value: { id: "one", count: 2 } },
                { kind: "put", objectType: "Other", key: "two", value: { id: "two", count: 3 } },
            ]);
            const marker = new Error("callback rejected");
            const failed = yield* Effect.result(
                backend.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.delete("Counter", "one");
                        return yield* Effect.fail(marker);
                    })
                )
            );
            expect(Result.isFailure(failed) && failed.failure).toBe(marker);
            const mismatch = new OntologyStorageError({
                operation: "read",
                reason: new SchemaMismatch({
                    message: "Definition changed.",
                    table: "Counter",
                    expected: 1,
                    actual: 2,
                }),
            });
            for (const operation of [backend.storage.read, backend.storage.transaction]) {
                const result = yield* Effect.result(operation(() => Effect.fail(mismatch)));
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch", retryable: false },
                });
            }
            expect(yield* backend.storage.read((tx) => tx.get("Counter", "one"))).toEqual({
                id: "one",
                count: 2,
            });
            yield* backend.storage.transaction((tx) =>
                tx.ensureIndex("Counter", { name: "count", field: { _tag: "Field", path: ["count"] } })
            );
            expect((yield* backend.changes!.pull({ cursor: page.cursor })).commits).toEqual([]);
        })
    );
});

test("a failed journal append rolls back the integration's object writes", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const raw = yield* Memory.make();
            let rejectJournal = false;
            const tables = {
                ...raw,
                insert: ((table, key, value) =>
                    rejectJournal && table.name === JSON.stringify(["backend", "journal-failure", "journal"])
                        ? Effect.die(new Error("journal unavailable"))
                        : raw.insert(table, key, value)) as typeof raw.insert,
            };
            const backend = yield* makeOwnedBackend({
                namespace: "journal-failure",
                ir,
                tables,
                mutators: {},
            });
            const before = yield* backend.loadSubset({ objectType: "Counter" });
            rejectJournal = true;
            const exit = yield* Effect.exit(
                backend.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }))
            );
            expect(exit._tag).toBe("Failure");
            rejectJournal = false;
            expect(yield* backend.storage.read((tx) => tx.get("Counter", "one"))).toBeUndefined();
            expect((yield* backend.changes!.pull({ cursor: before.cursor })).commits).toEqual([]);
            expect((yield* backend.loadSubset({ objectType: "Counter" })).cursor).toBe(before.cursor);
            yield* backend.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
            expect((yield* backend.changes!.pull({ cursor: before.cursor })).commits).toHaveLength(1);
        })
    );
});
