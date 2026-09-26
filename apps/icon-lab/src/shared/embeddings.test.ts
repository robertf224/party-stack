import { describe, expect, it } from "vitest";
import { QuantizedEmbeddingStore } from "./embeddings";
import type { EmbeddingIndexFile } from "./types";

const index: EmbeddingIndexFile = {
    generatedAt: "2026-08-15T00:00:00.000Z",
    model: "test",
    dims: 3,
    quantization: "per-vector-symmetric-int8",
    dataPath: "/test.i8",
    ids: ["a", "b", "opposite"],
    modalities: ["text", "multimodal", "image"],
};

describe("QuantizedEmbeddingStore", () => {
    const store = new QuantizedEmbeddingStore(
        index,
        new Int8Array([
            127, 0, 0,
            120, 10, 0,
            -127, 0, 0,
        ])
    );

    it("looks up vectors and preserves cosine similarity", () => {
        expect(store.has("a")).toBe(true);
        expect(store.similarity("a", "b")).toBeGreaterThan(0.99);
        expect(store.similarity("a", "opposite")).toBeCloseTo(-1);
    });

    it("returns normalized vectors for projection", () => {
        expect(store.vector("a")).toEqual([1, 0, 0]);
        expect(store.vector("missing")).toEqual([]);
    });
});
