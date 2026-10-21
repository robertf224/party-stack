import { expect, it as test } from "@effect/vitest";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect, Deferred, Fiber, Exit, Result } from "effect";
import * as Memory from "../memory/tables.js";
import { Table } from "../model.js";
import { makeBlobStorage, collectActionAttachments, type BlobBytesService } from "./index.js";

function memoryBytes() {
    const values = new Map<string, Blob>();
    const bytes: BlobBytesService = {
        read: (key) => Effect.sync(() => values.get(key)),
        write: (key, value) =>
            Effect.sync(() => {
                values.set(key, value);
            }),
        delete: (key) =>
            Effect.sync(() => {
                values.delete(key);
            }),
    };
    return { values, bytes };
}

test("durable outbox roots compose atomically, survive reopen and preserve aliases after byte eviction", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes, values } = memoryBytes();
                const blobs = yield* makeBlobStorage({ namespace: "retention", tables, bytes });
                yield* blobs.stage("local", new Blob(["payload"]));
                yield* tables.transaction((tx) => blobs.in(tx).retain("action:one", ["local"]));
                yield* blobs.bindRemoteId("local", "remote");
                const reopened = yield* makeBlobStorage({ namespace: "retention", tables, bytes });
                yield* tables.transaction((tx) => reopened.in(tx).retain("action:two", ["remote"]));
                expect(yield* reopened.collectGarbage({ olderThanMs: 0 })).toBe(0);
                yield* tables.transaction((tx) => reopened.in(tx).release("action:one"));
                expect(yield* reopened.collectGarbage({ olderThanMs: 0 })).toBe(0);
                yield* tables.transaction((tx) => reopened.in(tx).release("action:two"));
                expect(yield* reopened.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(values.size).toBe(0);
                expect(yield* reopened.metadata("remote")).toMatchObject({
                    id: "local",
                    remoteId: "remote",
                    size: 7,
                });
                expect(yield* reopened.read("local")).toBeUndefined();
                yield* reopened.cache("remote", new Blob(["fetched"]));
                expect(
                    yield* Effect.promise(() =>
                        Effect.runPromise(reopened.read("local")).then((blob) => blob!.text())
                    )
                ).toBe("fetched");
            })
        )
    );
});

test("failed enqueue transactions roll back roots and sole staged copies are never age-evicted", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes, values } = memoryBytes();
                const blobs = yield* makeBlobStorage({ namespace: "rollback", tables, bytes });
                yield* blobs.stage("staged", new Blob(["only-copy"]));
                yield* blobs.cache("remote", new Blob(["cache"]));
                const result = yield* Effect.result(
                    tables.transaction((tx) =>
                        blobs
                            .in(tx)
                            .retain("action", ["remote"])
                            .pipe(Effect.andThen(Effect.fail("enqueue rejected")))
                    )
                );
                expect(Result.isFailure(result)).toBe(true);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(values.size).toBe(1);
                expect((yield* blobs.read("staged"))?.size).toBe(9);
            })
        )
    );
});

test("an old deletion cannot remove a newly cached generation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes, values } = memoryBytes();
                const deleting = yield* Deferred.make<void>();
                const finish = yield* Deferred.make<void>();
                let held = true;
                const blobs = yield* makeBlobStorage({
                    namespace: "generations",
                    tables,
                    bytes: {
                        ...bytes,
                        delete: (key) =>
                            Effect.gen(function* () {
                                if (held) {
                                    held = false;
                                    yield* Deferred.succeed(deleting, undefined);
                                    yield* Deferred.await(finish);
                                }
                                yield* bytes.delete(key);
                            }),
                    },
                });
                yield* blobs.cache("remote", new Blob(["old"]));
                const gc = yield* Effect.forkScoped(blobs.collectGarbage({ olderThanMs: 0 }));
                yield* Deferred.await(deleting);
                yield* blobs.cache("remote", new Blob(["new"]));
                yield* Deferred.succeed(finish, undefined);
                expect(yield* Fiber.join(gc)).toBe(1);
                expect(values.size).toBe(1);
                expect(
                    yield* Effect.promise(() =>
                        Effect.runPromise(blobs.read("remote")).then((blob) => blob!.text())
                    )
                ).toBe("new");
            })
        )
    );
});

test("a reader protects its generation while external byte IO is in flight", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes } = memoryBytes();
                const reading = yield* Deferred.make<void>();
                const finish = yield* Deferred.make<void>();
                const blobs = yield* makeBlobStorage({
                    namespace: "readers",
                    tables,
                    bytes: {
                        ...bytes,
                        read: (key) =>
                            Deferred.succeed(reading, undefined).pipe(
                                Effect.andThen(Deferred.await(finish)),
                                Effect.andThen(bytes.read(key))
                            ),
                    },
                });
                yield* blobs.cache("remote", new Blob(["bytes"]));
                const reader = yield* Effect.forkScoped(blobs.read("remote"));
                yield* Deferred.await(reading);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(0);
                yield* Deferred.succeed(finish, undefined);
                expect((yield* Fiber.join(reader))?.size).toBe(5);
                expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(1);
            })
        )
    );
});

test("cancellation waits for a non-cancelable writer and never publishes its late bytes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes, values } = memoryBytes();
                let started!: () => void;
                const writing = new Promise<void>((resolve) => {
                    started = resolve;
                });
                let finish!: () => void;
                const done = new Promise<void>((resolve) => {
                    finish = resolve;
                });
                const blobs = yield* makeBlobStorage({
                    namespace: "cancel",
                    tables,
                    bytes: {
                        ...bytes,
                        write: (key, value) =>
                            Effect.promise(async () => {
                                started();
                                await done;
                                values.set(key, value);
                            }),
                    },
                });
                const writer = yield* Effect.forkScoped(blobs.stage("local", new Blob(["late"])));
                yield* Effect.promise(() => writing);
                const interrupted = yield* Effect.forkScoped(Fiber.interrupt(writer));
                yield* Effect.yieldNow;
                finish();
                yield* Fiber.join(interrupted);
                expect(Exit.isFailure(yield* Fiber.await(writer))).toBe(true);
                expect((yield* blobs.metadata("local"))?.byteKey).toBeUndefined();
                yield* blobs.recover;
                expect(values.size).toBe(0);
            })
        )
    );
});

test("GC retries durable deletion intents after a byte-store failure", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes, values } = memoryBytes();
                let fail = true;
                const blobs = yield* makeBlobStorage({
                    namespace: "delete-retry",
                    tables,
                    bytes: {
                        ...bytes,
                        delete: (key) => (fail ? Effect.fail("offline byte store") : bytes.delete(key)),
                    },
                });
                yield* blobs.cache("remote", new Blob(["cache"]));
                expect(Result.isFailure(yield* Effect.result(blobs.collectGarbage({ olderThanMs: 0 })))).toBe(
                    true
                );
                expect((yield* blobs.metadata("remote"))?.byteKey).toBeUndefined();
                expect(values.size).toBe(1);
                fail = false;
                const reopened = yield* makeBlobStorage({ namespace: "delete-retry", tables, bytes });
                yield* reopened.recover;
                expect(values.size).toBe(0);
            })
        )
    );
});

test("roots reject replacement writes, and recovery only removes abandoned owners", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const { bytes, values } = memoryBytes();
                const alive = new Set<string>();
                const blobs = yield* makeBlobStorage({
                    namespace: "recovery",
                    tables,
                    bytes,
                    registerOwner: (owner) =>
                        Effect.acquireRelease(
                            Effect.sync(() => {
                                alive.add(owner);
                            }),
                            () =>
                                Effect.sync(() => {
                                    alive.delete(owner);
                                })
                        ),
                    isOwnerAlive: (owner) => Effect.sync(() => alive.has(owner)),
                });
                yield* blobs.stage("local", new Blob(["original"]));
                yield* tables.transaction((tx) => blobs.in(tx).retain("action", ["local"]));
                const result = yield* Effect.result(blobs.stage("local", new Blob(["replacement"])));
                expect(
                    Result.isFailure(result) &&
                        result.failure._tag === "BlobStorageError" &&
                        result.failure.kind
                ).toBe("Conflict");
                const writes = Table.make<{ id: string; byteKey: string; owner: string }>({
                    name: JSON.stringify(["ontology", "recovery", "blobs", "writes"]),
                });
                values.set("orphan", new Blob(["orphan"]));
                yield* tables.put(writes, "abandoned", {
                    id: "unused",
                    byteKey: "orphan",
                    owner: "dead-process",
                });
                alive.add("live-process");
                values.set("active", new Blob(["active"]));
                yield* tables.put(writes, "active", {
                    id: "unused",
                    byteKey: "active",
                    owner: "live-process",
                });
                yield* blobs.recover;
                expect(values.has("orphan")).toBe(false);
                expect(values.has("active")).toBe(true);
                expect(yield* tables.get(writes, "active")).toBeDefined();
                yield* tables.transaction((tx) => blobs.in(tx).release("action"));
            })
        )
    );
});

test("attachment dependencies follow nested ontology unions, results, maps and lists", () => {
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
                parameters: [
                    {
                        name: "payload",
                        displayName: "Payload",
                        type: o.union({
                            variants: [
                                {
                                    name: "files",
                                    type: o.result({
                                        okType: o.map({
                                            keyType: o.string({}),
                                            valueType: o.list({ elementType: o.attachment({}) }),
                                        }),
                                        errType: o.string({}),
                                    }),
                                },
                            ],
                        }),
                    },
                ],
            },
        ],
    };
    const refs = collectActionAttachments(ir, "upload", {
        payload: {
            kind: "files",
            value: { kind: "ok", value: { first: [{ id: "one" }, { id: "two" }, { id: "one" }] } },
        },
    });
    expect(refs.map((ref) => ref.attachment.id)).toEqual(["one", "two"]);
});
