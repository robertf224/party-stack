import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { o } from "@party-stack/ontology-spec";
import { collectActionAttachments, makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore, makeNetworkConnectivity } from "@party-stack/runtime";
import { Effect, Fiber } from "effect";
import { expect, test } from "vite-plus/test";
import { replicaStateSource } from "../infrastructure.js";
import { makeReplica } from "../service.js";
import { makeActionAttachmentInputs } from "./inputs.js";
import { makeBlobManagerFromStorage } from "./manager.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [
        {
            name: "Bundle",
            type: o.struct({
                fields: [
                    {
                        name: "items",
                        displayName: "Items",
                        type: o.list({ elementType: o.optional({ type: o.attachment({}) }) }),
                    },
                    {
                        name: "byName",
                        displayName: "By name",
                        type: o.map({ keyType: o.string({}), valueType: o.attachment({}) }),
                    },
                ],
            }),
        },
    ],
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
                    name: "file",
                    displayName: "File",
                    type: o.attachment({ constraint: { size: { max: 8 } } }),
                },
                { name: "bundle", displayName: "Bundle", type: o.ref({ name: "Bundle" }) },
                {
                    name: "choice",
                    displayName: "Choice",
                    type: o.union({
                        variants: [
                            { name: "file", type: o.attachment({}) },
                            { name: "label", type: o.string({}) },
                        ],
                    }),
                },
            ],
        },
    ],
};
const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    const blobs = yield* makeBlobStorage({ namespace: "inputs", tables, bytes: new MemoryBlobBytesStore() });
    const manager = yield* makeBlobManagerFromStorage({
        storage: blobs,
        remote: { read: () => Effect.die("Unexpected remote read") },
    });
    return { tables, blobs, stage: yield* makeActionAttachmentInputs({ ir, manager }) };
});
const request = (file: Blob): ActionRequest => ({
    id: "operation",
    name: "upload",
    parameters: {
        file,
        bundle: { items: [new Blob(["nested"]), undefined], byName: { a: { id: "remote" } } },
        choice: { kind: "file", value: new Blob(["choice"]) },
    },
});
const offlineBackend = () =>
    makeOntologyBackend({
        ir,
        name: "offline",
        sourceId: "offline",
        supportsIdempotency: true,
        applyAction: () => Effect.die("Offline action was dispatched"),
        queryFunction: () => Effect.die("Unexpected function"),
        loadSubset: () => Effect.succeed({ rows: [], complete: true }),
    });

test("native action inputs stage declared files with scoped roots and preserve remote handles", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const input = request(new File(["hello"], "hello.txt", { type: "text/plain" }));
                const normalized = yield* f.stage(input, (value) =>
                    Effect.gen(function* () {
                        expect(
                            yield* f.blobs
                                .collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })
                                .pipe(Effect.orDie)
                        ).toBe(0);
                        return value;
                    })
                );
                expect(input.parameters.file).toBeInstanceOf(File);
                const files = collectActionAttachments(ir, "upload", normalized.parameters);
                expect(files).toHaveLength(4);
                const staged = files.filter((entry) => entry.attachment.id !== "remote");
                expect(staged).toHaveLength(3);
                expect(yield* f.blobs.metadata(staged[0]!.attachment.id)).toMatchObject({
                    name: "hello.txt",
                    size: 5,
                    type: "text/plain",
                });
                expect(yield* f.blobs.metadata("remote")).toBeUndefined();
                const repeated = yield* f.stage(
                    request(new File(["hello"], "hello.txt", { type: "text/plain" })),
                    Effect.succeed
                );
                expect(repeated).toEqual(normalized);
                expect(yield* f.blobs.records()).toHaveLength(3);
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(3);
            })
        )
    );
});

test("constraints reject before bytes are staged, including nested attachment targets", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                expect(
                    yield* Effect.result(f.stage(request(new Blob(["too many bytes"])), Effect.succeed))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidRequest", actionOutcome: "not-committed" },
                });
                expect(yield* f.blobs.records()).toHaveLength(0);
                const imageIR: OntologyIR = {
                    ...ir,
                    actionTypes: [
                        {
                            ...ir.actionTypes[0]!,
                            parameters: [
                                {
                                    name: "files",
                                    displayName: "Files",
                                    type: o.list({
                                        elementType: o.attachment({
                                            constraint: {
                                                content: {
                                                    kind: "image",
                                                    value: { mediaTypes: ["image/png"] },
                                                },
                                            },
                                        }),
                                    }),
                                },
                            ],
                        },
                    ],
                };
                const manager = yield* makeBlobManagerFromStorage({
                    storage: f.blobs,
                    remote: { read: () => Effect.die("Unexpected remote read") },
                });
                const stage = yield* makeActionAttachmentInputs({ ir: imageIR, manager });
                expect(
                    yield* Effect.result(
                        stage(
                            {
                                id: "image",
                                name: "upload",
                                parameters: { files: [new Blob(["x"], { type: "text/plain" })] },
                            },
                            Effect.succeed
                        )
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidRequest" },
                });
                expect(yield* f.blobs.records()).toHaveLength(0);
            })
        )
    );
});

test("file preparation freezes ordinary parameters before asynchronous byte reads", async () => {
    let signalStarted = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    class DelayedBlob extends Blob {
        override stream(): ReturnType<Blob["stream"]> {
            const reader = super.stream().getReader();
            return new ReadableStream({
                async pull(controller) {
                    signalStarted();
                    await released;
                    const next = await reader.read();
                    if (next.done) controller.close();
                    else controller.enqueue(next.value);
                },
                cancel: () => reader.cancel(),
            });
        }
    }
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const input = request(new DelayedBlob(["hello"]));
                const fiber = yield* f.stage(input, Effect.succeed).pipe(Effect.forkChild);
                yield* Effect.promise(() => started);
                (input.parameters.bundle as { byName: { a: { id: string } } }).byName.a.id = "changed";
                release();
                const frozen = yield* Fiber.join(fiber);
                expect(frozen.name).toBe("upload");
                expect(frozen.parameters.bundle).toMatchObject({ byName: { a: { id: "remote" } } });
            })
        )
    );
});

test("enqueue freezes handles offline, deduplicates files and rejects changed content for the same operation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const network = yield* makeNetworkConnectivity(false);
                const replica = yield* makeReplica({
                    namespace: "offline-inputs",
                    ir,
                    tables: f.tables,
                    blobs: f.blobs,
                    network,
                    backend: makeOntologyBackend({
                        ir,
                        name: "offline",
                        sourceId: "offline",
                        supportsIdempotency: true,
                        applyAction: () => Effect.die("Offline action was dispatched"),
                        queryFunction: () => Effect.die("Unexpected function"),
                        loadSubset: () => Effect.die("Unexpected load"),
                    }),
                });
                const original = request(new Blob(["one"]));
                const first = yield* replica.outbox.enqueue(original);
                expect((first.invocation.parameters.file as { id: string }).id).toMatch(
                    /^action-attachment:/
                );
                expect(yield* replica.outbox.enqueue(request(new Blob(["one"])))).toEqual(first);
                expect(yield* replica.outbox.entries).toHaveLength(1);
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(0);
                expect(
                    yield* Effect.result(replica.outbox.enqueue(request(new Blob(["two"]))))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "Conflict" } });
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(1);
                yield* replica.outbox.edit("operation", request(new Blob(["edit"])));
                const edited = (yield* replica.outbox.entries)[0]!;
                expect(edited.invocation.parameters.file).not.toEqual(first.invocation.parameters.file);
                yield* replica.outbox.remove("operation");
                // Four staged files and the now-unreferenced remote identity.
                expect(yield* f.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(5);
            })
        )
    );
});

test("file edits hand bytes to an accepting parent and repeated handoffs preserve referenced bytes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const parentStorage = yield* fixture();
                const parent = yield* makeReplica({
                    ir,
                    namespace: "parent-inputs",
                    ...parentStorage,
                    network: yield* makeNetworkConnectivity(false),
                    backend: offlineBackend(),
                });
                const local = yield* fixture();
                let rejectUpload = false;
                const child = yield* makeReplica({
                    ir,
                    namespace: "child-inputs",
                    ...local,
                    source: replicaStateSource(parent),
                    attachments: {
                        read: (value) => parent.attachments.source(value),
                        stage: (value, bytes) =>
                            rejectUpload
                                ? Effect.fail(
                                      new BackendError({
                                          operation: "attachment.stage",
                                          kind: "Unavailable",
                                          retryable: true,
                                          message: "Test upload interrupted.",
                                      })
                                  )
                                : parent.attachments
                                      .create(bytes, { id: value.id })
                                      .pipe(Effect.map((created) => created.attachment)),
                    },
                });
                yield* child.outbox.enqueue(request(new Blob(["first"])));
                yield* child.outbox.wait("operation", { until: "accepted" });
                yield* Effect.gen(function* () {
                    while ((yield* child.outbox.entries)[0]?.forwarding !== false) yield* Effect.yieldNow;
                }).pipe(Effect.timeout("2 seconds"));
                for (let repeat = 0; repeat < 2; repeat++)
                    yield* child.outbox.edit("operation", request(new Blob(["edited"])));
                const received = (yield* parent.outbox.entries)[0]!.invocation;
                const file = received.parameters.file as { id: string };
                const bytes = yield* parent.attachments.blob(file);
                expect(yield* Effect.promise(() => bytes.text())).toBe("edited");
                rejectUpload = true;
                expect(
                    yield* Effect.result(child.outbox.edit("operation", request(new Blob(["failed"]))))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "Unavailable" } });
                expect((yield* parent.outbox.entries)[0]!.invocation).toEqual(received);
                expect(yield* parentStorage.blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 })).toBe(
                    1
                );
                expect(
                    yield* Effect.result(parent.attachments.create(new Blob(["other"]), { id: file.id }))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Conflict" },
                });
                expect(yield* Effect.promise(() => bytes.text())).toBe("edited");
            })
        ).pipe(Effect.timeout("10 seconds"))
    );
});
