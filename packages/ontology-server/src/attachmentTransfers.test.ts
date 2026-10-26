import { BackendError } from "@party-stack/ontology-backend";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, test, vi } from "vite-plus/test";
import {
    AttachmentTransferRpcs,
    attachmentTransferHandlers,
    attachmentChunkSize,
} from "./attachmentTransfers.js";

const setup = Effect.fnUntraced(function* () {
    const stored = new Map<string, Blob>();
    const create = vi.fn((request: { id?: string }, blob: Blob) =>
        Effect.sync(() => {
            const id = request.id ?? "created";
            stored.set(id, blob);
            return { id };
        })
    );
    let allowed = true;
    const client = yield* RpcTest.makeClient(AttachmentTransferRpcs).pipe(
        Effect.provide(
            attachmentTransferHandlers({
                authorizeUpload: () =>
                    allowed
                        ? Effect.void
                        : Effect.fail(
                              new BackendError({
                                  operation: "authorize",
                                  kind: "ValidationFailed",
                                  message: "Denied",
                                  retryable: false,
                              })
                          ),
                create,
                read: (attachment) => Effect.succeed(stored.get(attachment.id)!),
            })
        )
    );
    return {
        client,
        create,
        stored,
        deny: () => {
            allowed = false;
        },
    };
});

test("uploads publish only after the declared byte count arrives, and downloads use bounded frames", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { client, create, stored } = yield* setup();
                const ready = yield* Deferred.make<string>();
                let completed: string | undefined;
                const upload = yield* Effect.forkScoped(
                    Stream.runForEach(
                        client.CreateAttachment({
                            id: "file",
                            size: attachmentChunkSize + 1,
                            type: "text/plain",
                            name: "note.txt",
                        }),
                        (event) =>
                            event.kind === "ready"
                                ? Deferred.succeed(ready, event.uploadId).pipe(Effect.asVoid)
                                : Effect.sync(() => {
                                      completed = event.attachment.id;
                                  })
                    )
                );
                const uploadId = yield* Deferred.await(ready);
                yield* client.WriteAttachmentChunk({
                    uploadId,
                    sequence: 0,
                    bytes: new Uint8Array(attachmentChunkSize).fill(65),
                    end: false,
                });
                expect(create).not.toHaveBeenCalled();
                yield* client.WriteAttachmentChunk({
                    uploadId,
                    sequence: 1,
                    bytes: new Uint8Array([66]),
                    end: true,
                });
                yield* Fiber.join(upload);
                expect(completed).toBe("file");
                expect(stored.get("file")!.size).toBe(attachmentChunkSize + 1);
                const frames = yield* Stream.runCollect(client.ReadAttachment({ id: "file" }));
                expect(frames[0]).toMatchObject({
                    kind: "metadata",
                    size: attachmentChunkSize + 1,
                    type: "text/plain",
                    name: "note.txt",
                });
                const bytes = frames.flatMap((frame) => (frame.kind === "bytes" ? [frame.bytes] : []));
                expect(bytes.every((chunk) => chunk.length <= attachmentChunkSize)).toBe(true);
                expect(bytes.reduce((size, chunk) => size + chunk.length, 0)).toBe(attachmentChunkSize + 1);
                expect(bytes.at(-1)!.at(-1)).toBe(66);
            })
        )
    );
});

for (const invalid of ["sequence", "size"] as const) {
    test(`rejects an invalid upload ${invalid} without publishing a partial attachment`, async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const { client, create } = yield* setup();
                    const ready = yield* Deferred.make<string>();
                    const upload = yield* Effect.forkScoped(
                        Effect.result(
                            Stream.runForEach(client.CreateAttachment({ size: 2, type: "" }), (event) =>
                                event.kind === "ready"
                                    ? Deferred.succeed(ready, event.uploadId).pipe(Effect.asVoid)
                                    : Effect.void
                            )
                        )
                    );
                    const uploadId = yield* Deferred.await(ready);
                    expect(
                        yield* Effect.result(
                            client.WriteAttachmentChunk({
                                uploadId,
                                sequence: invalid === "sequence" ? 1 : 0,
                                bytes: new Uint8Array([1]),
                                end: true,
                            })
                        )
                    ).toMatchObject({ _tag: "Failure", failure: { kind: "ValidationFailed" } });
                    expect(yield* Fiber.join(upload)).toMatchObject({ _tag: "Failure" });
                    expect(create).not.toHaveBeenCalled();
                })
            )
        );
    });
}

test("cancelling the owning stream releases an incomplete upload; later chunks cannot revive it", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { client, create } = yield* setup();
                const scope = yield* Scope.make();
                const ready = yield* Deferred.make<string>();
                yield* Effect.forkIn(
                    Stream.runForEach(client.CreateAttachment({ size: 3, type: "" }), (event) =>
                        event.kind === "ready"
                            ? Deferred.succeed(ready, event.uploadId).pipe(Effect.asVoid)
                            : Effect.void
                    ),
                    scope
                );
                const uploadId = yield* Deferred.await(ready);
                yield* client.WriteAttachmentChunk({
                    uploadId,
                    sequence: 0,
                    bytes: new Uint8Array([1]),
                    end: false,
                });
                yield* Scope.close(scope, Exit.void);
                expect(
                    yield* Effect.result(
                        client.WriteAttachmentChunk({
                            uploadId,
                            sequence: 1,
                            bytes: new Uint8Array([2, 3]),
                            end: true,
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "ValidationFailed" } });
                expect(create).not.toHaveBeenCalled();
            })
        )
    );
});

test("authorization is checked before upload allocation and again for chunks", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { client, create, deny } = yield* setup();
                const ready = yield* Deferred.make<string>();
                const upload = yield* Effect.forkScoped(
                    Stream.runForEach(client.CreateAttachment({ size: 0, type: "" }), (event) =>
                        event.kind === "ready"
                            ? Deferred.succeed(ready, event.uploadId).pipe(Effect.asVoid)
                            : Effect.void
                    )
                );
                const uploadId = yield* Deferred.await(ready);
                deny();
                expect(
                    yield* Effect.result(
                        client.WriteAttachmentChunk({
                            uploadId,
                            sequence: 0,
                            bytes: new Uint8Array(),
                            end: true,
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { message: "Denied" } });
                expect(
                    yield* Effect.result(Stream.runCollect(client.CreateAttachment({ size: 0, type: "" })))
                ).toMatchObject({ _tag: "Failure", failure: { message: "Denied" } });
                yield* Fiber.interrupt(upload);
                expect(create).not.toHaveBeenCalled();
            })
        )
    );
});
