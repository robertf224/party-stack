import { expect, it } from "@effect/vitest";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect, Deferred, Fiber, Exit, Result, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Memory from "../memory/tables.js";
import { Table } from "../model.js";
import { byteSource } from "./bytes.js";
import {
    makeBlobStorage,
    collectActionAttachments,
    collectByteBlob,
    byteIO,
    type BlobBytesService,
} from "./index.js";

function memoryBytes() {
    const values = new Map<string, Blob>();
    const bytes: BlobBytesService = {
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
    };
    return { values, bytes };
}

it("durable outbox roots compose atomically, survive reopen and preserve aliases after byte eviction", async () => {
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

it("failed enqueue transactions roll back roots and sole staged copies survive the cache eviction policy", async () => {
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

it("an old deletion cannot remove a newly cached generation", async () => {
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

it("a reader protects its generation while external byte IO is in flight", async () => {
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

it("cancellation waits for a non-cancelable writer and never publishes its late bytes", async () => {
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
                            byteIO(async () => {
                                const blob = await Effect.runPromise(collectByteBlob(value));
                                started();
                                await done;
                                values.set(key, blob);
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

it("GC retries durable deletion intents after a byte-store failure", async () => {
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

it("roots reject replacement writes, and recovery only removes abandoned owners", async () => {
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

it("attachment dependencies follow nested ontology unions, results, maps and lists", () => {
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

it.effect("orphan grace expires raw staged bytes, and renewed ownership restarts the grace", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const { bytes, values } = memoryBytes();
        const blobs = yield* makeBlobStorage({ namespace: "orphan-grace", tables, bytes });
        yield* blobs.stage("raw", new Blob(["raw"]));
        yield* TestClock.adjust(59 * 60_000);
        expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(0);
        yield* tables.transaction((tx) => blobs.in(tx).retain("draft", ["raw"], { bytes: false }));
        yield* TestClock.adjust(2 * 60_000);
        expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(0);
        yield* tables.transaction((tx) => blobs.in(tx).release("draft"));
        expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(0);
        yield* TestClock.adjust(60 * 60_000);
        expect(yield* blobs.collectGarbage({ olderThanMs: 0 })).toBe(1);
        expect(yield* blobs.metadata("raw")).toBeUndefined();
        expect(values.size).toBe(0);
    }).pipe(Effect.scoped)
);

it.effect(
    "identity roots permit cache eviction, byte pins do not; authoritative storage preserves referenced bytes",
    () =>
        Effect.gen(function* () {
            for (const mode of ["replica", "authoritative"] as const) {
                const tables = yield* Memory.make();
                const { bytes } = memoryBytes();
                const blobs = yield* makeBlobStorage({ namespace: mode, tables, bytes, mode });
                yield* blobs.cache("remote", new Blob(["cache"]));
                yield* tables.transaction((tx) =>
                    blobs.in(tx).retain("object", ["remote"], { bytes: false })
                );
                yield* tables.transaction((tx) => blobs.in(tx).retain("offline", ["remote"]));
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                yield* tables.transaction((tx) => blobs.in(tx).release("offline"));
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(
                    mode === "replica" ? 1 : 0
                );
                expect(yield* blobs.metadata("remote")).toBeDefined();
                yield* tables.transaction((tx) => blobs.in(tx).release("object"));
                expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                expect(yield* blobs.metadata("remote")).toBeUndefined();
            }
        }).pipe(Effect.scoped)
);

it.effect("transactional aliases merge a prior remote cache and transfer its retention roots", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const { bytes, values } = memoryBytes();
        const blobs = yield* makeBlobStorage({ namespace: "merge", tables, bytes });
        yield* blobs.stage("local", new Blob(["uploaded"]));
        yield* blobs.cache("remote", new Blob(["cached"]));
        yield* tables.transaction((tx) => blobs.in(tx).retain("remote-pin", ["remote"]));
        const failed = yield* Effect.result(
            tables.transaction((tx) =>
                blobs
                    .in(tx)
                    .bindRemoteId("local", "remote")
                    .pipe(Effect.andThen(Effect.fail("rollback")))
            )
        );
        expect(Result.isFailure(failed)).toBe(true);
        expect((yield* blobs.metadata("remote"))?.id).toBe("remote");
        yield* tables.transaction((tx) => blobs.in(tx).bindRemoteId("local", "remote"));
        yield* blobs.recover;
        expect(values.size).toBe(1);
        expect((yield* blobs.metadata("remote"))?.id).toBe("local");
        expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
        yield* tables.transaction((tx) => blobs.in(tx).release("remote-pin"));
        expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect("scoped reads pin file-backed content until the consumer finishes or is interrupted", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const { bytes } = memoryBytes();
        const blobs = yield* makeBlobStorage({ namespace: "stream-reader", tables, bytes });
        yield* blobs.cache("remote", new Blob(["streamable"]));
        const reader = yield* Scope.make();
        const content = yield* Scope.provide(blobs.readScoped("remote"), reader);
        expect(content).toBeDefined();
        expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
        const received = yield* Effect.tryPromise(() =>
            new Response(Stream.toReadableStream(content!.stream)).text()
        );
        expect(received).toBe("streamable");
        yield* Scope.close(reader, Exit.void);
        expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect("only replica storage may retain an attachment whose bytes are not local", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const { bytes } = memoryBytes();
        for (const mode of ["replica", "authoritative"] as const) {
            const blobs = yield* makeBlobStorage({ namespace: `availability:${mode}`, tables, bytes, mode });
            const retained = yield* Effect.result(
                tables.transaction((tx) => blobs.in(tx).retain("object", ["missing"], { bytes: false }))
            );
            expect(Result.isFailure(retained)).toBe(mode === "authoritative");
            if (Result.isFailure(retained)) expect(retained.failure).toMatchObject({ kind: "NotFound" });
            expect(yield* blobs.metadata("missing")).toEqual(
                mode === "authoritative" ? undefined : expect.objectContaining({ id: "missing" })
            );
        }
    }).pipe(Effect.scoped)
);

it.effect("stages a generated stream incrementally and publishes its measured size only at EOF", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const { bytes } = memoryBytes();
        const blobs = yield* makeBlobStorage({ namespace: "recording", tables, bytes });
        const first = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const stream = Stream.concat(
            Stream.fromEffect(Deferred.succeed(first, undefined).pipe(Effect.as(new Uint8Array([1, 2])))),
            Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(new Uint8Array([3]))))
        );
        const writer = yield* Effect.forkScoped(blobs.stage("audio", { type: "audio/webm", stream }));
        yield* Deferred.await(first);
        expect(yield* blobs.metadata("audio")).toMatchObject({ writing: expect.any(String) });
        expect((yield* blobs.metadata("audio"))?.byteKey).toBeUndefined();
        expect(yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(writer);
        expect(yield* blobs.metadata("audio")).toMatchObject({
            size: 3,
            type: "audio/webm",
            writing: undefined,
        });
    }).pipe(Effect.scoped)
);

it.effect(
    "rejects truncated streams and releases interrupted recording writes without publishing bytes",
    () =>
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const { bytes, values } = memoryBytes();
            const blobs = yield* makeBlobStorage({ namespace: "incomplete-streams", tables, bytes });
            expect(
                Result.isFailure(
                    yield* Effect.result(
                        blobs.stage("truncated", {
                            type: "",
                            size: 2,
                            stream: Stream.succeed(new Uint8Array([1])),
                        })
                    )
                )
            ).toBe(true);
            const started = yield* Deferred.make<void>();
            const stream = Stream.concat(
                Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(new Uint8Array([1])))),
                Stream.never
            );
            const writer = yield* Effect.forkScoped(blobs.stage("interrupted", { type: "", stream }));
            yield* Deferred.await(started);
            yield* Fiber.interrupt(writer);
            expect((yield* blobs.metadata("interrupted"))?.writing).toBeUndefined();
            expect((yield* blobs.metadata("interrupted"))?.byteKey).toBeUndefined();
            yield* blobs.recover;
            expect(values.size).toBe(0);
        }).pipe(Effect.scoped)
);
