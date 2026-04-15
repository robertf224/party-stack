import { describe, expect, it } from "vitest";
import { resolveAttachment } from "./index.js";

describe("resolveAttachment", () => {
    it("materializes attachment metadata and blob", async () => {
        const blob = new Blob(["hello"], { type: "text/plain" });

        const result = await resolveAttachment({
            id: "attachment-1",
            metadata: () =>
                Promise.resolve({
                filename: "hello.txt",
                size: blob.size,
                type: blob.type,
                }),
            blob: () => Promise.resolve(blob),
        });

        expect(result).toEqual({
            id: "attachment-1",
            metadata: {
                filename: "hello.txt",
                size: 5,
                type: "text/plain",
            },
            blob,
        });
    });
});
