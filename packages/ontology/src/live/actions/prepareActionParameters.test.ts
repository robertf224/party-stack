import { o } from "@party-stack/ontology-spec";
import { memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createBlobManager } from "../../runtime/blobs/createBlobManager.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
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
    it("collects action attachment uploads with resolved attachment type targets", async () => {
        const runtime = memoryRuntimeFixture("test", "prepare-action");
        const blobManager = createBlobManager({
            runtime,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                read: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await blobManager.stage("attachment-1", new Blob(["hello"]));

        const prepared = await Effect.runPromise(
            prepareActionParameters({
                ir,
                actionTypeName: "uploadDocument",
                parameters: {
                    file: { id: "attachment-1" },
                },
                blobManager,
            })
        );

        expect(prepared.attachmentUploads).toHaveLength(1);
        expect(prepared.attachmentUploads[0]).toMatchObject({
            attachment: { id: "attachment-1" },
        });
        expect(prepared.attachmentUploads[0]!.target).toEqual({});
        await expect(prepared.attachmentUploads[0]!.blob.text()).resolves.toBe("hello");
        await blobManager.cleanup();
        await runtime.cleanup();
    });

    it("leaves remote handles unchanged without downloading cached or unseen bytes", async () => {
        const runtime = memoryRuntimeFixture("test", "remote-action");
        const remoteRead = vi.fn(() => Promise.reject(new Error("must not download")));
        const manager = createBlobManager({ runtime, remote: { read: remoteRead } });
        await manager.stage("local-id", new Blob(["hello"]));
        await manager.bindRemoteId("local-id", "remote-id");
        for (const id of ["remote-id", "unseen-remote-id"]) {
            const parameters = { file: { id } };
            const prepared = await Effect.runPromise(
                prepareActionParameters({
                    ir,
                    actionTypeName: "uploadDocument",
                    parameters,
                    blobManager: manager,
                })
            );
            expect(prepared.parameters).toEqual(parameters);
            expect(prepared.attachmentUploads).toEqual([]);
        }
        expect(remoteRead).not.toHaveBeenCalled();
        await manager.cleanup();
        await runtime.cleanup();
    });
});
