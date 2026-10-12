import { describe, expect, it, vi } from "vite-plus/test";
import { fromBatches, toArray } from "./AsyncIterable.js";

describe("fromBatches", () => {
    it("loads inputs in bounded batches and yields returned results", async () => {
        const getBatch = vi.fn((batch: number[]) =>
            Promise.resolve(batch.filter((value) => value % 2 === 1))
        );

        await expect(toArray(fromBatches([1, 2, 3, 4, 5], getBatch, 2))).resolves.toEqual([1, 3, 5]);
        expect(getBatch.mock.calls).toEqual([[[1, 2]], [[3, 4]], [[5]]]);
    });

    it("rejects invalid batch sizes", async () => {
        await expect(toArray(fromBatches([1], (batch) => Promise.resolve(batch), 0))).rejects.toThrow(
            "Batch size must be a positive integer."
        );
    });
});
