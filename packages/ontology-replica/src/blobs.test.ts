import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { byteSource } from "@party-stack/ontology-storage/blobs";
import { makeBlobStorage, collectByteBlob, BlobStorageError } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Deferred, Fiber, Effect, Result, Scope, Exit, Stream } from "effect";
import { expect, test } from "vitest";
import { replicaStateSource, makeReplica } from "./index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [
        {
            name: "upload",
            displayName: "Upload",
            logic: [],
            parameters: [{ name: "file", displayName: "File", type: o.attachment({}) }],
        },
    ],
};

test("staged outbox bytes survive upload, lost receipts and reopen until reconciliation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const values = new Map<string, Blob>();
                const blobs = yield* makeBlobStorage({
                    namespace: "attachments",
                    tables,
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
                yield* blobs.stage("local", new Blob(["pending bytes"]));
                let loseReceipt = true;
                const backend: OntologyBackendService = {
                    name: "test",
                    queryFunction: () => Effect.succeed(undefined),
                    sourceId: "test",
                    supportsIdempotency: true,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: (invocation) =>
                        Effect.gen(function* () {
                            // Materialization succeeds before the action response is lost.
                            yield* blobs.bindRemoteId("local", "remote").pipe(Effect.orDie);
                            if (loseReceipt)
                                return yield* new BackendError({
                                    operation: "applyAction",
                                    kind: "Unavailable",
                                    message: "Response lost",
                                    retryable: true,
                                });
                            return { operationId: invocation.id, outcome: "committed" as const };
                        }),
                };
                const options = {
                    namespace: "local",
                    ir,
                    tables,
                    blobs,
                    backend,
                    execute: () => Effect.void,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                };
                const firstScope = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(options), firstScope);
                yield* first.enqueue({ id: "upload", name: "upload", parameters: { file: { id: "local" } } });
                expect(Result.isFailure(yield* Effect.result(first.syncOnce))).toBe(true);
                expect((yield* first.pending)[0]?.attempts).toBe(1);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(0);
                yield* Scope.close(firstScope, Exit.void);
                const reopened = yield* makeReplica(options);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(0);
                loseReceipt = false;
                yield* reopened.syncOnce;
                expect(yield* reopened.pending).toEqual([]);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(values.size).toBe(0);
                expect(yield* blobs.metadata("remote")).toMatchObject({ id: "local", remoteId: "remote" });
            })
        )
    );
});

test("editing and removing pending actions atomically replace and release attachment roots", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const values = new Map<string, Blob>();
                const blobs = yield* makeBlobStorage({
                    namespace: "edit-attachments",
                    tables,
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
                for (const id of ["one", "two"]) {
                    yield* blobs.stage(id, new Blob([id]));
                    yield* blobs.bindRemoteId(id, `remote-${id}`);
                }
                const replica = yield* makeReplica({
                    namespace: "local",
                    ir,
                    tables,
                    blobs,
                    execute: () => Effect.void,
                    startSync: false,
                    outbox: { retryDelayMs: 0 },
                    backend: {
                        name: "offline",
                        queryFunction: () => Effect.succeed(undefined),
                        sourceId: "offline",
                        supportsIdempotency: false,
                        loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                        applyAction: () => Effect.die("No dispatch expected"),
                    },
                });
                yield* replica.enqueue({ id: "action", name: "upload", parameters: { file: { id: "one" } } });
                yield* replica.edit("action", {
                    id: "action",
                    name: "upload",
                    parameters: { file: { id: "two" } },
                });
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect((yield* blobs.metadata("one"))?.byteKey).toBeUndefined();
                expect((yield* blobs.metadata("two"))?.byteKey).toBeDefined();
                yield* replica.remove("action");
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(values.size).toBe(0);
            })
        )
    );
});

test("a mapping race preserves the receipt and recovers without another remote invocation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const values = new Map<string, Blob>();
                const reading = yield* Deferred.make<void>();
                const finish = yield* Deferred.make<void>();
                const blobs = yield* makeBlobStorage({
                    namespace: "mapping-race",
                    tables,
                    bytes: {
                        read: (key) =>
                            Deferred.succeed(reading, undefined).pipe(
                                Effect.andThen(Deferred.await(finish)),
                                Effect.as(values.get(key)),
                                Effect.map((value) => (value === undefined ? undefined : byteSource(value)))
                            ),
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
                yield* blobs.stage("local", new Blob(["uploaded"]));
                yield* blobs.cache("remote", new Blob(["remote"]));
                const reader = yield* Effect.forkScoped(blobs.read("remote"));
                yield* Deferred.await(reading);
                let calls = 0;
                const backend: OntologyBackendService = {
                    name: "mapping",
                    sourceId: "mapping",
                    supportsIdempotency: false,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    queryFunction: () => Effect.void,
                    applyAction: (invocation) =>
                        Effect.sync(() => {
                            calls++;
                            return {
                                operationId: invocation.id,
                                outcome: "committed" as const,
                                attachmentIdMappings: [{ localId: "local", remoteId: "remote" }],
                            };
                        }),
                };
                const settings = {
                    namespace: "mapping-race",
                    ir,
                    tables,
                    blobs,
                    backend,
                    execute: () => Effect.void,
                    startSync: false,
                };
                const owner = yield* Scope.make();
                const first = yield* Scope.provide(makeReplica(settings), owner);
                yield* first.enqueue({ id: "action", name: "upload", parameters: { file: { id: "local" } } });
                expect(Result.isFailure(yield* Effect.result(first.syncOnce))).toBe(true);
                expect((yield* first.pending)[0]).toMatchObject({
                    state: "acknowledged",
                    attempts: 1,
                    receipt: {
                        outcome: "committed",
                        attachmentIdMappings: [{ localId: "local", remoteId: "remote" }],
                    },
                });
                yield* Scope.close(owner, Exit.void);
                yield* Deferred.succeed(finish, undefined);
                yield* Fiber.join(reader);
                const reopened = yield* makeReplica(settings);
                yield* reopened.syncOnce;
                expect(calls).toBe(1);
                expect(yield* reopened.pending).toEqual([]);
                expect((yield* blobs.metadata("remote"))?.id).toBe("local");
            })
        )
    );
});

test("replica snapshots and optimistic rows retain attachment identities and release them on removal", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const values = new Map<string, Blob>();
                const blobs = yield* makeBlobStorage({
                    namespace: "row-retention",
                    tables,
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
                            name: "Document",
                            displayName: "Document",
                            pluralDisplayName: "Documents",
                            primaryKey: "id",
                            properties: [
                                { name: "id", displayName: "ID", type: o.string({}) },
                                { name: "file", displayName: "File", type: o.attachment({}) },
                            ],
                        },
                    ],
                };
                let rows = [{ key: "doc", value: { id: "doc", file: { id: "cached" } } }];
                const replica = yield* makeReplica({
                    namespace: "row-retention",
                    ir: definition,
                    tables,
                    blobs,
                    startSync: false,
                    backend: {
                        name: "rows",
                        sourceId: "rows",
                        supportsIdempotency: false,
                        loadSubset: () => Effect.succeed({ rows, complete: true }),
                        queryFunction: () => Effect.void,
                        applyAction: () => Effect.die("offline"),
                    },
                    execute: (tx, invocation) =>
                        tx.put("Document", { id: "optimistic", file: invocation.parameters.file }),
                });
                let owner = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Document" }), owner);
                yield* replica.syncOnce;
                yield* blobs.cache("cached", new Blob(["cache"]));
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect(yield* blobs.metadata("cached")).toBeDefined();
                rows = [];
                yield* Scope.close(owner, Exit.void);
                owner = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Document" }), owner);
                yield* replica.syncOnce;
                // A complete replacement snapshot removes the old row's reverse references.
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect(yield* blobs.metadata("cached")).toBeUndefined();
                yield* Scope.close(owner, Exit.void);
                yield* blobs.stage("local", new Blob(["draft"]));
                yield* replica.enqueue({
                    id: "action",
                    name: "upload",
                    parameters: { file: { id: "local" } },
                });
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                yield* replica.remove("action");
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
            })
        )
    );
});

test("a speculative child owns byte retention and saves a terminal receipt before alias reconciliation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const store = Effect.fnUntraced(function* (namespace: string) {
                    const tables = yield* Memory.make();
                    const values = new Map<string, Blob>();
                    const blobs = yield* makeBlobStorage({
                        namespace,
                        tables,
                        bytes: {
                            read: (key) =>
                                Effect.sync(() => {
                                    const value = values.get(key);
                                    return value === undefined ? undefined : byteSource(value);
                                }),
                            write: (key, bytes) =>
                                collectByteBlob(bytes).pipe(
                                    Effect.tap((value) => Effect.sync(() => values.set(key, value))),
                                    Effect.asVoid
                                ),
                            delete: (key) =>
                                Effect.sync(() => {
                                    values.delete(key);
                                }),
                        },
                    });
                    return { tables, blobs, values };
                });
                const parentStore = yield* store("parent-bytes");
                const childStore = yield* store("child-bytes");
                let applications = 0;
                const backend: OntologyBackendService = {
                    name: "provider",
                    sourceId: "provider",
                    supportsIdempotency: true,
                    queryFunction: () => Effect.succeed(undefined),
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: (request) =>
                        Effect.sync(() => {
                            applications++;
                            return {
                                operationId: request.id,
                                outcome: "committed" as const,
                                affected: [],
                                attachmentIdMappings: [{ localId: "local", remoteId: "provider-id" }],
                            };
                        }),
                };
                const parent = yield* makeReplica({
                    namespace: "parent",
                    ir,
                    ...parentStore,
                    backend,
                    execute: () => Effect.void,
                    startSync: false,
                });
                yield* childStore.blobs.stage("local", new Blob(["kept by child outbox"]));
                // Host composition streams this copy before submitting the action.
                yield* parentStore.blobs.stage("local", new Blob(["kept by child outbox"]));
                let failMapping = false;
                const blobs = {
                    ...childStore.blobs,
                    in: (tx: Parameters<typeof childStore.blobs.in>[0]) => ({
                        ...childStore.blobs.in(tx),
                        bindRemoteId: (local: string, remote?: string) =>
                            failMapping
                                ? Effect.fail(
                                      new BlobStorageError({
                                          kind: "Busy",
                                          message: "Injected mapping failure.",
                                      })
                                  )
                                : childStore.blobs.in(tx).bindRemoteId(local, remote),
                    }),
                };
                const options = {
                    namespace: "child",
                    ir,
                    tables: childStore.tables,
                    blobs,
                    source: replicaStateSource(parent),
                    execute: () => Effect.void,
                    startSync: false,
                };
                const childScope = yield* Scope.make();
                const child = yield* Scope.provide(makeReplica(options), childScope);
                yield* child.enqueue({ id: "upload", name: "upload", parameters: { file: { id: "local" } } });
                yield* child.syncOnce;
                expect(yield* child.pending).toEqual([]);
                expect(yield* childStore.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                expect(childStore.values.size).toBe(1);
                yield* parent.syncOnce;
                failMapping = true;
                expect((yield* Effect.result(child.syncOnce))._tag).toBe("Failure");
                const outbox = Table.make<{ receipt?: { outcome: string } }>({
                    name: JSON.stringify(["replica", "child", "outbox"]),
                });
                expect((yield* childStore.tables.get(outbox, "upload"))?.receipt?.outcome).toBe("committed");
                expect(applications).toBe(1);
                yield* Scope.close(childScope, Exit.void);
                failMapping = false;
                const reopened = yield* makeReplica(options);
                const snapshot = yield* parent.snapshotState;
                // Even after the parent's result log expires, local evidence survives.
                yield* reopened.receiveParentState(
                    {
                        ...snapshot,
                        view: (yield* reopened.parentState)?.view,
                        revision: snapshot.revision + 1,
                        completed: [],
                    },
                    ["upload"]
                );
                expect((yield* reopened.receipt("upload"))?.outcome).toBe("committed");
                expect((yield* childStore.blobs.metadata("local"))?.remoteId).toBe("provider-id");
                expect(yield* childStore.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect(childStore.values.size).toBe(0);
                expect(parentStore.values.size).toBe(1); // Child eviction never deletes parent bytes.
                expect(applications).toBe(1);
            })
        )
    );
});

test("staged-copy validation and parent acceptance are atomic, while duplicate submissions need no bytes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const values = new Map<string, Blob>();
                const blobs = yield* makeBlobStorage({
                    namespace: "required",
                    tables,
                    bytes: {
                        read: (key) =>
                            Effect.sync(() => {
                                const value = values.get(key);
                                return value === undefined ? undefined : byteSource(value);
                            }),
                        write: (key, input) =>
                            collectByteBlob(input).pipe(
                                Effect.tap((blob) => Effect.sync(() => values.set(key, blob))),
                                Effect.asVoid
                            ),
                        delete: (key) =>
                            Effect.sync(() => {
                                values.delete(key);
                            }),
                    },
                });
                let applications = 0;
                const backend: OntologyBackendService = {
                    name: "required",
                    sourceId: "required",
                    supportsIdempotency: true,
                    queryFunction: () => Effect.succeed(undefined),
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: (invocation) =>
                        Effect.sync(() => {
                            applications++;
                            return {
                                operationId: invocation.id,
                                outcome: "committed" as const,
                                affected: [],
                            };
                        }),
                };
                const parent = yield* makeReplica({
                    namespace: "required-parent",
                    ir,
                    tables,
                    blobs,
                    backend,
                    execute: () => Effect.void,
                    startSync: false,
                });
                const session = yield* parent.openClient();
                const request = {
                    session,
                    sequence: 1,
                    optimistic: true,
                    stagedAttachments: ["upload"],
                    invocation: { id: "action", name: "upload", parameters: { file: { id: "upload" } } },
                };
                const missing = yield* Effect.result(parent.submitClient(request));
                expect(missing).toMatchObject({
                    _tag: "Failure",
                    failure: {
                        kind: "NotFound",
                        operation: "replica.submit.attachments",
                        actionOutcome: "not-committed",
                    },
                });
                expect(yield* parent.pending).toEqual([]);
                yield* blobs.stage("upload", new Blob(["bytes"]));
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect((yield* Effect.result(parent.submitClient(request)))._tag).toBe("Failure");
                yield* blobs.stage("upload", new Blob(["bytes"]));
                yield* parent.submitClient(request);
                expect(yield* parent.pending).toHaveLength(1);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                yield* parent.syncOnce;
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                const duplicate = yield* parent.submitClient(request);
                expect(duplicate.state.completed[0]?.receipt?.outcome).toBe("committed");
                expect(applications).toBe(1);
            })
        )
    );
});

test("plain replica reads and observations attach source locators without changing stored rows", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const property = (name: string, type: import("@party-stack/ontology-spec").TypeDef) => ({
                    name,
                    displayName: name,
                    type,
                });
                const definition: OntologyIR = {
                    ...ir,
                    objectTypes: [
                        {
                            name: "Item",
                            displayName: "Item",
                            pluralDisplayName: "Items",
                            primaryKey: "id",
                            properties: [
                                property("id", o.string({})),
                                property("file", o.attachment({})),
                                property("secret", o.encrypted({ type: o.string({}) })),
                            ],
                        },
                    ],
                };
                const tables = yield* Memory.make();
                const value = { id: "item", file: { id: "bytes" }, secret: { ciphertext: "opaque" } };
                const replica = yield* makeReplica({
                    ir: definition,
                    namespace: "read-sources",
                    tables,
                    startSync: false,
                    gc: false,
                    execute: () => Effect.void,
                    backend: {
                        name: "source",
                        sourceId: "source",
                        supportsIdempotency: false,
                        loadSubset: () => Effect.succeed({ rows: [{ key: "item", value }], complete: true }),
                        applyAction: () => Effect.die("No writes expected"),
                        queryFunction: () => Effect.void,
                    },
                });
                yield* replica.demand({ objectType: "Item" });
                yield* replica.syncOnce;
                const expected = {
                    id: "item",
                    file: {
                        id: "bytes",
                        source: { objectType: "Item", primaryKey: "item", property: "file" },
                    },
                    secret: {
                        ciphertext: "opaque",
                        source: { objectType: "Item", primaryKey: "item", property: "secret" },
                    },
                };
                expect(yield* replica.get("Item", "item")).toEqual(expected);
                expect(yield* replica.confirmed.get("Item", "item")).toEqual(expected);
                expect((yield* replica.loadSubset("Item"))[0]?.value).toEqual(expected);
                expect((yield* replica.snapshotSubset({ objectType: "Item" })).rows[0]?.value).toEqual(
                    expected
                );
                const batches = yield* Stream.runCollect(Stream.take(replica.observeRows("Item"), 1));
                expect(batches[0]?.rows[0]?.value).toEqual(expected);
                const raw = Table.make<Record<string, unknown>>({
                    name: JSON.stringify(["replica", "read-sources", "base:Item"]),
                });
                expect(yield* tables.get(raw, "item")).toEqual(value);
                expect(value.file).toEqual({ id: "bytes" });
            })
        )
    );
});
