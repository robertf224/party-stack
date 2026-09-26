import { describe, expect, it } from "vitest";
import { averageVectors, cosineSimilarity, l2Normalize, projectTo2d } from "./math";

describe("math", () => {
    it("normalizes vectors to unit length", () => {
        const normalized = l2Normalize([3, 4]);
        expect(normalized[0]).toBeCloseTo(0.6);
        expect(normalized[1]).toBeCloseTo(0.8);
    });

    it("computes cosine similarity for aligned vectors", () => {
        const a = l2Normalize([1, 0, 0]);
        const b = l2Normalize([1, 0, 0]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(1);
    });

    it("averages multimodal vectors", () => {
        const mixed = averageVectors([
            [1, 0],
            [0, 1],
        ]);
        expect(mixed[0]).toBeCloseTo(Math.SQRT1_2);
        expect(mixed[1]).toBeCloseTo(Math.SQRT1_2);
    });

    it("projects points into 2d", () => {
        const points = projectTo2d([
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [1, 1, 0],
        ]);
        expect(points).toHaveLength(4);
        expect(Number.isFinite(points[0]!.x)).toBe(true);
        expect(Number.isFinite(points[0]!.y)).toBe(true);
    });
});
