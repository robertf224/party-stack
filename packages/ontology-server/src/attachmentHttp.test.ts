import { o, type OntologyIR } from "@party-stack/ontology";
import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { byteChunks, collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, test, vi } from "vite-plus/test";
import { connectOntologyBackendHttp, makeOntologyHttpHandler } from "./rpcHttp.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [
        {
            name: "save",
            displayName: "Save",
            logic: [],
            parameters: [
                { name: "files", displayName: "Files", type: o.list({ elementType: o.attachment({}) }) },
            ],
        },
    ],
};
const setup = Effect.fnUntraced(function* () {
    const first = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const stage = vi.fn(() =>
        Effect.fail(
            new BackendError({
                operation: "stage",
                kind: "NotImplemented",
                message: "No proxy staging store.",
                retryable: false,
            })
        )
    );
    const committed = vi.fn();
    const calls: string[] = [];
    let allowed = true;
    const authorize = vi.fn(() =>
        allowed
            ? Effect.void
            : Effect.fail(
                  new BackendError({
                      operation: "authorize",
                      kind: "Forbidden",
                      message: "Denied",
                      retryable: false,
                      actionOutcome: "not-committed",
                  })
              )
    );
    const backend: OntologyBackendService = {
        name: "provider",
        sourceId: "provider",
        supportsIdempotency: false,
        loadSubset: () => Effect.succeed({ rows: [], complete: true }),
        queryFunction: () => Effect.succeed(undefined),
        attachments: {
            stage,
            read: () => Effect.die("Unexpected read"),
            metadata: () => Effect.die("Unexpected metadata"),
        },
        applyAction: (request) =>
            Effect.gen(function* () {
                for (const upload of request.attachmentUploads ?? []) {
                    const source = {
                        ...("arrayBuffer" in upload.blob ? {} : upload.blob),
                        type: "application/octet-stream",
                        stream: byteChunks(upload.blob).pipe(
                            Stream.tap(() => Deferred.succeed(first, undefined))
                        ),
                    };
                    yield* collectByteBlob(source).pipe(
                        Effect.mapError((cause) =>
                            cause instanceof BackendError
                                ? cause
                                : new BackendError({
                                      operation: "applyAction",
                                      kind: "InvalidRequest",
                                      message: "Invalid upload.",
                                      retryable: false,
                                  })
                        )
                    );
                }
                committed();
                return {
                    operationId: request.id,
                    outcome: "committed" as const,
                    attachmentIdMappings: [{ localId: "audio", remoteId: "provider-audio" }],
                };
            }),
    };
    // Every HTTP request constructs a fresh server, as a stateless Worker may do.
    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
        Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const request = new Request(input, init);
                    calls.push(request.headers.get("content-type") ?? "");
                    const handler = yield* makeOntologyHttpHandler({
                        ir,
                        backend,
                        authorize,
                    });
                    const response = yield* Effect.promise(() => handler(request));
                    const body = yield* Effect.promise(() => response.arrayBuffer());
                    return new Response(body, { status: response.status, headers: response.headers });
                })
            )
        );
    const client = yield* connectOntologyBackendHttp({ url: "https://ontology.test/rpc" }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch)
    );
    return {
        client,
        first,
        finish,
        stage,
        committed,
        calls,
        authorize,
        deny: () => {
            allowed = false;
        },
    };
});

test("multipart action uploads stream directly through a stateless proxy without standalone staging", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { client, first, finish, stage, committed, calls } = yield* setup();
                const stream = Stream.concat(
                    Stream.succeed(new Uint8Array(4096)),
                    Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(new Uint8Array([3]))))
                );
                const action = yield* Effect.forkScoped(
                    client.applyAction({
                        id: "action",
                        name: "save",
                        parameters: { files: [{ id: "audio" }] },
                        attachmentUploads: [
                            { attachment: { id: "audio" }, blob: { stream, type: "audio/webm" } },
                        ],
                    })
                );
                yield* Deferred.await(first);
                expect(committed).not.toHaveBeenCalled();
                expect(stage).not.toHaveBeenCalled();
                yield* Deferred.succeed(finish, undefined);
                expect(yield* Fiber.join(action)).toMatchObject({
                    operationId: "action",
                    attachmentIdMappings: [{ localId: "audio", remoteId: "provider-audio" }],
                });
                expect(committed).toHaveBeenCalledOnce();
                expect(calls.filter((type) => type.startsWith("multipart/form-data"))).toHaveLength(1);
            })
        )
    );
});

test("multipart actions reauthorize before final EOF and reject truncated uploads without dispatch", async () => {
    for (const mode of ["revoked", "truncated"] as const) {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const { client, first, finish, committed, deny } = yield* setup();
                    const stream = Stream.concat(
                        Stream.succeed(new Uint8Array(4096)),
                        Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(new Uint8Array([3]))))
                    );
                    const action = yield* Effect.forkScoped(
                        Effect.result(
                            client.applyAction({
                                id: mode,
                                name: "save",
                                parameters: { files: [{ id: "audio" }] },
                                attachmentUploads: [
                                    {
                                        attachment: { id: "audio" },
                                        blob: {
                                            stream,
                                            type: "audio/webm",
                                            size: mode === "truncated" ? 5000 : undefined,
                                        },
                                    },
                                ],
                            })
                        )
                    );
                    yield* Deferred.await(first);
                    if (mode === "revoked") deny();
                    yield* Deferred.succeed(finish, undefined);
                    expect(yield* Fiber.join(action)).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: mode === "revoked" ? "Forbidden" : "InvalidRequest" },
                    });
                    expect(committed).not.toHaveBeenCalled();
                })
            )
        );
    }
});
