import {
    makeReplicaLiveOntology,
    makeStorageOntologyBackend,
    o,
    type LiveOntology,
    type OntologyIR,
    type OntologyMutatorRegistry,
} from "@party-stack/ontology";
import { replicaStateSource } from "@party-stack/ontology-replica";
import { byteSource, collectByteBlob, makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import { MemoryBlobBytesStore, Runtime } from "@party-stack/runtime";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, test, vi } from "vite-plus/test";
import { connectLiveOntology } from "./liveClient.js";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";

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
                { name: "file", displayName: "File", type: o.attachment({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "save",
            displayName: "Save",
            logic: [],
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "file", displayName: "File", type: o.attachment({}) },
            ],
        },
    ],
};
const mutators: OntologyMutatorRegistry = { save: ({ tx, args }) => tx.mutate.Item!.create(args) };

test("an owned RPC parent accepts locally staged child attachments through its committed facet", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* Runtime.make({
                    owner: "authority",
                    namespace: "committed",
                    blobBytes: new MemoryBlobBytesStore(),
                });
                const blobs = yield* makeBlobStorage({
                    namespace: "committed",
                    tables: authority.tables,
                    bytes: authority.bytes,
                });
                const backend = yield* makeStorageOntologyBackend({
                    namespace: "committed",
                    ir,
                    tables: authority.tables,
                    blobs,
                    mutators,
                });
                const rpc = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(ontologyRpcHandlers({ backend, ir, authorize: () => Effect.void }))
                );
                const connection = yield* makeOntologyProtocolClient(rpc);
                expect(connection.replication.kind).toBe("committed");
                const childRuntime = yield* Runtime.make({
                    owner: "user",
                    namespace: "committed-child",
                    blobBytes: new MemoryBlobBytesStore(),
                });
                const child = yield* connectLiveOntology({
                    ir,
                    connection: Effect.succeed(connection),
                    writes: { defaultMode: "outbox", defaultVisibility: "optimistic", mutators },
                }).pipe(Effect.provideService(Runtime, childRuntime));
                const { attachment } = yield* Effect.promise(() =>
                    child.attachments.create(new Blob(["committed bytes"]))
                );
                yield* Effect.promise(() => child.actions.save!({ id: "one", file: attachment }));
                expect((yield* backend.loadSubset({ objectType: "Item" })).rows[0]?.value.file).toMatchObject(
                    { id: attachment.id }
                );
                const content = yield* backend
                    .attachments!.read(attachment)
                    .pipe(Effect.flatMap(collectByteBlob));
                expect(yield* Effect.promise(() => content.text())).toBe("committed bytes");
            })
        )
    );
});

test("a speculative client stages locally, transfers before acceptance, and streams cold reads through both caches", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authorityRuntime = yield* Runtime.make({
                    owner: "authority",
                    namespace: "authority",
                    blobBytes: new MemoryBlobBytesStore(),
                });
                const authorityBlobs = yield* makeBlobStorage({
                    namespace: "authority",
                    tables: authorityRuntime.tables,
                    bytes: authorityRuntime.bytes,
                });
                const owned = yield* makeStorageOntologyBackend({
                    namespace: "authority",
                    ir,
                    tables: authorityRuntime.tables,
                    blobs: authorityBlobs,
                    mutators,
                });
                const release = yield* Deferred.make<void>();
                const first = yield* Deferred.make<void>();
                let reads = 0;
                const metadata = vi.fn(
                    (
                        value: Parameters<NonNullable<typeof owned.attachments>["metadata"]>[0],
                        options?: Parameters<NonNullable<typeof owned.attachments>["metadata"]>[1]
                    ) =>
                        value.id === "metadata-only"
                            ? Effect.succeed({ size: 1234 })
                            : owned.attachments!.metadata(value, options)
                );
                const backend = {
                    ...owned,
                    attachments: {
                        ...owned.attachments!,
                        metadata,
                        read: (value: Parameters<NonNullable<typeof owned.attachments>["read"]>[0]) =>
                            owned.attachments!.read(value).pipe(
                                Effect.map((input) => {
                                    reads++;
                                    let index = 0;
                                    const source = byteSource(input);
                                    return {
                                        ...source,
                                        stream: source.stream.pipe(
                                            Stream.flatMap((chunk) =>
                                                Stream.fromArray(
                                                    [chunk.subarray(0, 4), chunk.subarray(4)].filter(
                                                        (part) => part.length > 0
                                                    )
                                                )
                                            ),
                                            Stream.mapEffect((chunk) =>
                                                ++index === 1
                                                    ? Effect.succeed(chunk)
                                                    : Deferred.await(release).pipe(Effect.as(chunk))
                                            )
                                        ),
                                    };
                                })
                            ),
                    },
                };
                const parentBytes = new MemoryBlobBytesStore();
                const parentRuntime = yield* Runtime.make({
                    owner: "user",
                    namespace: "parent",
                    blobBytes: parentBytes,
                });
                const parent = yield* makeReplicaLiveOntology({
                    ir,
                    runtime: parentRuntime.adapter,
                    context: {},
                    backendAdapter: { name: "authority", open: () => Effect.succeed(backend) },
                    writes: { defaultMode: "outbox", defaultVisibility: "optimistic", mutators },
                }).pipe(Effect.provideService(Runtime, parentRuntime));
                const parentView = {
                    ...parent,
                    cleanup: async () => {},
                    destroy: async () => {},
                } as LiveOntology;
                const rpc = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            ir,
                            source: replicaStateSource(parent.storage!),
                            ontology: parentView,
                            authorize: () => Effect.void,
                            errors: "forward",
                        })
                    )
                );
                const connection = yield* makeOntologyProtocolClient(rpc);
                const childBytes = new MemoryBlobBytesStore();
                const childRuntime = yield* Runtime.make({
                    owner: "user",
                    namespace: "child",
                    blobBytes: childBytes,
                });
                const child = yield* connectLiveOntology({
                    ir,
                    connection: Effect.succeed(connection),
                    writes: { defaultMode: "outbox", defaultVisibility: "optimistic", mutators },
                }).pipe(Effect.provideService(Runtime, childRuntime));
                expect(
                    yield* Effect.promise(() =>
                        child.attachments.metadata({ id: "metadata-only" }, { select: ["size"] })
                    )
                ).toMatchObject({ size: 1234 });
                expect(metadata).toHaveBeenCalledExactlyOnceWith(
                    { id: "metadata-only" },
                    { select: ["size"] }
                );
                expect(reads).toBe(0);
                expect(childBytes.blobs.size).toBe(0);
                expect(parentBytes.blobs.size).toBe(0);
                // The selected fields are cached as metadata without materializing bytes.
                yield* Effect.promise(() =>
                    child.attachments.metadata({ id: "metadata-only" }, { select: ["size"] })
                );
                expect(metadata).toHaveBeenCalledOnce();
                yield* child.storage!.retainLocal("Item");
                const created = yield* Effect.promise(() =>
                    child.attachments.create(new Blob(["headtail"], { type: "text/plain" }))
                );
                expect(childBytes.blobs.size).toBe(1);
                expect(parentBytes.blobs.size).toBe(0);
                yield* Effect.promise(() => child.actions.save!({ id: "one", file: created.attachment }));
                expect((yield* owned.loadSubset({ objectType: "Item" })).rows[0]?.value.file).toMatchObject({
                    id: created.attachment.id,
                });
                expect(parentBytes.blobs.size).toBe(1);
                const childBlobs = yield* makeBlobStorage({
                    namespace: JSON.stringify(["user", "child"]),
                    tables: childRuntime.tables,
                    bytes: childRuntime.bytes,
                });
                const parentBlobs = yield* makeBlobStorage({
                    namespace: JSON.stringify(["user", "parent"]),
                    tables: parentRuntime.tables,
                    bytes: parentRuntime.bytes,
                });
                // Each cache has the file plus the unreferenced metadata-only record.
                expect(yield* childBlobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(2);
                expect(yield* parentBlobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(2);
                expect(childBytes.blobs.size).toBe(0);
                expect(parentBytes.blobs.size).toBe(0);
                const source = yield* Effect.promise(() => child.attachments.source(created.attachment));
                const consuming = yield* collectByteBlob({
                    ...source,
                    stream: source.stream.pipe(Stream.tap(() => Deferred.succeed(first, undefined))),
                }).pipe(Effect.forkScoped);
                yield* Deferred.await(first).pipe(Effect.timeout("2 seconds"));
                expect(childBytes.blobs.size).toBe(0);
                expect(parentBytes.blobs.size).toBe(0);
                yield* Deferred.succeed(release, undefined);
                const complete = yield* Fiber.join(consuming);
                expect(yield* Effect.promise(() => complete.text())).toBe("headtail");
                expect(childBytes.blobs.size).toBe(1);
                expect(parentBytes.blobs.size).toBe(1);
                expect(reads).toBe(1);
                expect(
                    yield* Effect.promise(async () =>
                        (await child.attachments.blob(created.attachment)).text()
                    )
                ).toBe("headtail");
                expect(reads).toBe(1);
            })
        )
    );
});
