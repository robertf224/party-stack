import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Fiber, Effect, Result, Scope, Exit } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./index.js";

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
                        read: (key) => Effect.succeed(values.get(key)),
                        write: (key, value) =>
                            Effect.sync(() => {
                                values.set(key, value);
                            }),
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
                    invoke: (invocation) =>
                        Effect.gen(function* () {
                            // Materialization succeeds before the action response is lost.
                            yield* blobs.bindRemoteId("local", "remote").pipe(Effect.orDie);
                            if (loseReceipt)
                                return yield* new BackendError({
                                    operation: "invoke",
                                    kind: "Unavailable",
                                    message: "Response lost",
                                    retryable: true,
                                });
                            return { invocationId: invocation.id, outcome: "committed" as const };
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
                        read: (key) => Effect.succeed(values.get(key)),
                        write: (key, value) =>
                            Effect.sync(() => {
                                values.set(key, value);
                            }),
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
                        invoke: () => Effect.die("No dispatch expected"),
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
                                Effect.as(values.get(key))
                            ),
                        write: (key, value) =>
                            Effect.sync(() => {
                                values.set(key, value);
                            }),
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
                    invoke: (invocation) =>
                        Effect.sync(() => {
                            calls++;
                            return {
                                invocationId: invocation.id,
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
                        read: (key) => Effect.succeed(values.get(key)),
                        write: (key, value) =>
                            Effect.sync(() => {
                                values.set(key, value);
                            }),
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
                        invoke: () => Effect.die("offline"),
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
