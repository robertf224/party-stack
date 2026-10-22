import { o, makeStorageOntologyBackend, type OntologyMutatorRegistry } from "@party-stack/ontology";
import { sqliteOntologyConformanceIR } from "@party-stack/ontology/testing/sqlite";
import { makeHelpers } from "alchemy/Cloudflare/R2/BucketBinding";
import { makeReadWrite } from "alchemy/Cloudflare/R2/ReadWriteBucketBinding";
import { DurableObjectState, fromDurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { makeAlchemyOntology } from "../src/alchemy/index.js";
import { makeDurableObjectOntologyStorage, makeR2Bytes } from "../src/index.js";
import { r2Prefix } from "../src/r2Keys.js";
import { testBucket, withTestRuntime } from "./bindings.js";
import { runOntologyResource, type ResourceResult } from "./resource.js";
import type { Bucket } from "alchemy/Cloudflare/R2/Bucket";

interface Environment {
    BLOBS: R2Bucket;
}

/** Real Alchemy binding clients over workerd SQLite and R2; no cloud deployment. */
export class AlchemyOntologyTest extends DurableObject<Environment> {
    runResource(disabled: boolean): Promise<ResourceResult> {
        return Effect.runPromise(
            Effect.scoped(
                runOntologyResource(
                    this.ctx as unknown as Parameters<typeof runOntologyResource>[0],
                    this.env.BLOBS,
                    disabled
                )
            )
        );
    }

    crashAfterWrite() {
        const state = this.ctx;
        const bucket = this.env.BLOBS;
        return Effect.runPromise(
            withTestRuntime(
                Effect.scoped(
                    Effect.gen(function* () {
                        const bytes = yield* makeR2Bytes({
                            bucket: testBucket(bucket),
                            installationId: state.id.toString(),
                            ontologyId: "crash",
                        });
                        const { blobs } = yield* makeDurableObjectOntologyStorage({
                            storage: state.storage,
                            ontologyId: "crash",
                            bytes: {
                                ...bytes,
                                write: (id, value) =>
                                    bytes
                                        .write(id, value)
                                        .pipe(
                                            Effect.andThen(
                                                Effect.sync(() =>
                                                    state.abort("Intentional crash after R2 write")
                                                )
                                            )
                                        ),
                            },
                        });
                        yield* blobs.stage("interrupted", new Blob(["unpublished"]));
                    })
                ),
                bucket
            )
        );
    }

    crashDuringRead() {
        const state = this.ctx;
        const bucket = this.env.BLOBS;
        return Effect.runPromise(
            withTestRuntime(
                Effect.scoped(
                    Effect.gen(function* () {
                        const bytes = yield* makeR2Bytes({
                            bucket: testBucket(bucket),
                            installationId: state.id.toString(),
                            ontologyId: "crash",
                        });
                        const { blobs } = yield* makeDurableObjectOntologyStorage({
                            storage: state.storage,
                            ontologyId: "crash",
                            bytes,
                        });
                        yield* blobs.stage("interrupted", new Blob(["reader"]));
                        yield* blobs.readScoped("interrupted");
                        yield* Effect.sync(() => state.abort("Intentional crash during scoped read"));
                    })
                ),
                bucket
            )
        );
    }

    recoverAfterCrash() {
        const state = this.ctx;
        const bucket = this.env.BLOBS;
        return Effect.runPromise(
            withTestRuntime(
                Effect.scoped(
                    Effect.gen(function* () {
                        const bytes = yield* makeR2Bytes({
                            bucket: testBucket(bucket),
                            installationId: state.id.toString(),
                            ontologyId: "crash",
                        });
                        const storage = yield* makeDurableObjectOntologyStorage({
                            storage: state.storage,
                            ontologyId: "crash",
                            bytes,
                        });
                        const before = yield* storage.blobs.metadata("interrupted");
                        yield* makeStorageOntologyBackend({
                            ir: sqliteOntologyConformanceIR,
                            namespace: "crash",
                            ...storage,
                        });
                        const recovered = yield* storage.blobs.metadata("interrupted");
                        const collected = yield* storage.blobs.collectGarbage({
                            olderThanMs: 0,
                            orphanGraceMs: 0,
                        });
                        const prefix = yield* Effect.promise(() =>
                            r2Prefix({ installationId: state.id.toString(), ontologyId: "crash" })
                        );
                        const remaining = yield* Effect.promise(() => bucket.list({ prefix }));
                        yield* storage.blobs.stage("interrupted", new Blob(["recovered"]));
                        const content = yield* storage.blobs.read("interrupted");
                        return {
                            wasWriting: Boolean(before?.writing),
                            writing: Boolean(recovered?.writing),
                            collected,
                            remaining: remaining.objects.length,
                            content: yield* Effect.promise(() => content!.text()),
                        };
                    })
                ),
                bucket
            )
        );
    }

    runRetention() {
        // Runtime binding helpers use only the resource's logical binding name.
        const bucket = makeReadWrite(
            makeHelpers({ BLOBS: this.env.BLOBS }, { LogicalId: "BLOBS" } as Bucket)
        );
        const definition = {
            ...sqliteOntologyConformanceIR,
            actionTypes: [
                ...sqliteOntologyConformanceIR.actionTypes,
                {
                    name: "removeAsset",
                    displayName: "Remove asset",
                    parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
                    logic: [],
                },
                {
                    name: "rejectAsset",
                    displayName: "Reject asset",
                    parameters: [{ name: "attachment", displayName: "Attachment", type: o.attachment({}) }],
                    logic: [],
                },
            ],
        };
        return Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const mutators: OntologyMutatorRegistry = {
                        removeAsset: async ({ tx, args }) => {
                            await tx.mutate.Asset!.delete(args.id as string);
                        },
                        rejectAsset: () => {
                            throw new Error("Rejected by the application");
                        },
                    };
                    const options = { ir: definition, bucket, ontologyId: "alchemy", mutators };
                    const { backend, blobs } = yield* makeAlchemyOntology(options);
                    const upload = {
                        attachment: { id: "shared" },
                        blob: new File(["shared bytes"], "shared.txt", { type: "text/plain" }),
                        target: {},
                    };
                    yield* backend.invoke({
                        id: "one",
                        name: "createAsset",
                        parameters: { id: "first", attachment: upload.attachment },
                        attachmentUploads: [upload],
                    });
                    yield* backend.invoke({
                        id: "two",
                        name: "createAsset",
                        parameters: { id: "second", attachment: upload.attachment },
                        attachmentUploads: [upload],
                    });
                    const conflict = yield* Effect.result(
                        backend.invoke({
                            id: "conflicting-upload",
                            name: "createAsset",
                            parameters: { id: "third", attachment: upload.attachment },
                            attachmentUploads: [{ ...upload, blob: new Blob(["different bytes"]) }],
                        })
                    );
                    const range = yield* backend.attachments!.read(upload.attachment, {
                        offset: 7,
                        length: 5,
                    });
                    const rangeText = yield* Effect.promise(() => range.text());
                    const protectedCount = yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 });
                    const reopened = yield* makeAlchemyOntology(options);
                    const content = yield* reopened.backend.attachments!.read(upload.attachment);
                    const text = yield* Effect.promise(() => content.text());
                    yield* reopened.backend.invoke({
                        id: "remove-one",
                        name: "removeAsset",
                        parameters: { id: "first" },
                    });
                    const stillShared = yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 });
                    yield* reopened.backend.invoke({
                        id: "remove-two",
                        name: "removeAsset",
                        parameters: { id: "second" },
                    });
                    const collected = yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 });
                    const missing = yield* Effect.result(
                        reopened.backend.attachments!.read(upload.attachment)
                    );
                    const rejected = yield* Effect.result(
                        backend.invoke({
                            id: "rejected",
                            name: "rejectAsset",
                            parameters: { attachment: { id: "orphan" } },
                            attachmentUploads: [{ ...upload, attachment: { id: "orphan" } }],
                        })
                    );
                    const orphanCount = yield* blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 });
                    yield* blobs.stage("empty", new Blob([]));
                    const empty = yield* blobs.read("empty");
                    const emptyText = yield* Effect.promise(() => empty!.text());
                    return {
                        conflict: Result.isFailure(conflict) && conflict.failure.kind === "Conflict",
                        rangeText,
                        emptyText,
                        protectedCount,
                        text,
                        stillShared,
                        collected,
                        missing: Result.isFailure(missing),
                        rejected: Result.isFailure(rejected),
                        orphanCount,
                    };
                })
            ).pipe(
                Effect.provideService(
                    DurableObjectState,
                    fromDurableObjectState(
                        // Alchemy and the test runner currently ship different Workers type versions.
                        this.ctx as unknown as Parameters<typeof fromDurableObjectState>[0]
                    )
                ),
                Effect.provideService(RuntimeContext, {
                    Type: "Cloudflare.Worker",
                    id: "alchemy-test",
                    env: { BLOBS: this.env.BLOBS },
                    get: () => Effect.succeed(undefined),
                    set: (id) => Effect.succeed(id),
                })
            )
        );
    }
}
