import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { o } from "@party-stack/ontology-spec";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { Runtime } from "@party-stack/runtime";
import { MemoryRuntime, RuntimePartition } from "@party-stack/runtime";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeBlobManagerFromStorage, type BlobManagerOptions } from "./manager.js";
import { prepareActionParameters } from "./prepare.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [
        {
            name: "uploadDocument",
            displayName: "Upload Document",
            parameters: [
                {
                    name: "file",
                    displayName: "File",
                    type: o.attachment({}),
                },
            ],
            logic: [],
        },
    ],
    queryFunctionTypes: [],
};

describe("prepareActionParameters", () => {
    it("reuses a remote handle when the replica has no local byte storage", async () => {
        const parameters = { file: { id: "remote-only" } };
        await expect(
            Effect.runPromise(prepareActionParameters({ ir, actionTypeName: "uploadDocument", parameters }))
        ).resolves.toEqual({ parameters, attachmentUploads: [] });
    });
    it("collects staged bytes with their resolved attachment type targets", async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const manager = yield* makeBlobManager({
                        remote: { read: () => Effect.die("Unexpected remote read") },
                    });
                    yield* manager.stage("attachment-1", new Blob(["hello"]));
                    const prepared = yield* prepareActionParameters({
                        ir,
                        actionTypeName: "uploadDocument",
                        parameters: { file: { id: "attachment-1" } },
                        blobManager: manager,
                    });
                    expect(prepared.attachmentUploads).toHaveLength(1);
                    expect(prepared.attachmentUploads[0]).toMatchObject({
                        attachment: { id: "attachment-1" },
                        target: {},
                    });
                    const blob = yield* collectByteBlob(prepared.attachmentUploads[0]!.blob);
                    expect(yield* Effect.promise(() => blob.text())).toBe("hello");
                })
            ).pipe(
                Effect.provide(MemoryRuntime.layer),
                Effect.provideService(RuntimePartition, { owner: "test", namespace: "prepare-action" })
            )
        );
    });
    it("reuses remote handles without downloading cached or unseen bytes", async () => {
        const read = vi.fn(() => Effect.die("Must not download"));
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const manager = yield* makeBlobManager({ remote: { read } });
                    yield* manager.stage("local-id", new Blob(["hello"]));
                    yield* manager.bindRemoteId("local-id", "remote-id");
                    for (const id of ["remote-id", "unseen-remote-id"]) {
                        const parameters = { file: { id } };
                        const prepared = yield* prepareActionParameters({
                            ir,
                            actionTypeName: "uploadDocument",
                            parameters,
                            blobManager: manager,
                        });
                        expect(prepared.parameters).toEqual(parameters);
                        expect(prepared.attachmentUploads).toEqual([]);
                    }
                    expect(read).not.toHaveBeenCalled();
                })
            ).pipe(
                Effect.provide(MemoryRuntime.layer),
                Effect.provideService(RuntimePartition, { owner: "test", namespace: "remote-action" })
            )
        );
    });
});

const makeBlobManager = Effect.fnUntraced(function* (options: BlobManagerOptions) {
    const runtime = yield* Runtime;
    const storage = yield* makeBlobStorage({
        namespace: JSON.stringify([runtime.owner, runtime.namespace]),
        tables: runtime.tables,
        bytes: runtime.bytes,
        ...exclusiveOwnerLiveness(runtime.tables),
    }).pipe(Effect.mapError((cause) => classifyBackendFailure("attachment.storage", cause)));
    return yield* makeBlobManagerFromStorage({ ...options, storage });
});
