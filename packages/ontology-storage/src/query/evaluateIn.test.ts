import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { inArray, type Scalar } from "../model.js";
import { compareScalar, matches } from "./evaluate.js";

const scalar = Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.BigInt,
    Schema.Undefined,
    Schema.Null,
]);
const field = { _tag: "Field", path: ["nested", "value"] } as const;

it.live.prop(
    "IN agrees with independent scalar-comparison membership for fields and literals",
    [scalar, Schema.Array(scalar)],
    ([left, values]) =>
        Effect.sync(() => {
            const expected = values.some((candidate) => compareScalar(left, candidate) === 0);
            expect(matches({ nested: { value: left } }, inArray(field, values as Scalar[]))).toBe(expected);
            expect(matches({}, inArray(left as Scalar, values as Scalar[]))).toBe(expected);
        }),
    { arbitrary: { runs: 1000 } }
);

test("IN preserves scalar-family distinctions, rich-value equality, and invalid-value short circuits", () => {
    const values = [
        undefined,
        null,
        false,
        true,
        -0,
        1,
        2n,
        "",
        "1",
        "😀",
        new Date("2026-11-09T00:00:00Z"),
        Temporal.Instant.from("2026-11-09T00:00:00Z"),
        Temporal.PlainDate.from("2026-11-09"),
    ];
    for (const left of values)
        for (const candidates of [[], [left], values.slice(1), [...values].reverse()]) {
            const expected = candidates.some((candidate) => compareScalar(left, candidate) === 0);
            expect(matches({ nested: { value: left } }, inArray(field, candidates as Scalar[]))).toBe(
                expected
            );
            expect(matches({}, inArray(left as Scalar, candidates as Scalar[]))).toBe(expected);
        }
    expect(
        matches({}, inArray(new Date("2026-11-09T00:00:00Z"), [new Date("2026-11-09T00:00:00Z")] as Scalar[]))
    ).toBe(true);
    expect(
        matches(
            {},
            inArray(Temporal.Instant.from("2026-11-09T00:00:00Z"), [
                Temporal.Instant.from("2026-11-09T00:00:00Z"),
            ] as Scalar[])
        )
    ).toBe(true);
    expect(matches({}, inArray("ok", ["ok", new Date(NaN)] as Scalar[]))).toBe(true);
    expect(() => matches({}, inArray("ok", [new Date(NaN), "ok"] as Scalar[]))).toThrow();
    expect(matches({}, inArray(new Date(NaN), [] as Scalar[]))).toBe(false);
    expect(() => matches({}, inArray(new Date(NaN), [0] as Scalar[]))).toThrow();
});

test("IN resolves a nested field once per row and does not read it for an empty set", () => {
    let reads = 0;
    const row = {
        get nested() {
            reads++;
            return { value: "match" };
        },
    };
    expect(matches(row, inArray(field, [] as Scalar[]))).toBe(false);
    expect(reads).toBe(0);
    expect(matches(row, inArray(field, ["one", "two", "match"] as Scalar[]))).toBe(true);
    expect(reads).toBe(1);
    expect(matches(row, inArray(field, ["one", "two", "three"] as Scalar[]))).toBe(false);
    expect(reads).toBe(2);
});
