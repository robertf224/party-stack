import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
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
            expect(matches({ nested: { value: left } }, { op: "in", left: field, values })).toBe(expected);
            expect(matches({}, { op: "in", left, values })).toBe(expected);
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
            expect(matches({ nested: { value: left } }, { op: "in", left: field, values: candidates })).toBe(
                expected
            );
            expect(matches({}, { op: "in", left, values: candidates })).toBe(expected);
        }
    expect(
        matches(
            {},
            { op: "in", left: new Date("2026-11-09T00:00:00Z"), values: [new Date("2026-11-09T00:00:00Z")] }
        )
    ).toBe(true);
    expect(
        matches(
            {},
            {
                op: "in",
                left: Temporal.Instant.from("2026-11-09T00:00:00Z"),
                values: [Temporal.Instant.from("2026-11-09T00:00:00Z")],
            }
        )
    ).toBe(true);
    expect(matches({}, { op: "in", left: "ok", values: ["ok", new Date(NaN)] })).toBe(true);
    expect(() => matches({}, { op: "in", left: "ok", values: [new Date(NaN), "ok"] })).toThrow();
    expect(matches({}, { op: "in", left: new Date(NaN), values: [] })).toBe(false);
    expect(() => matches({}, { op: "in", left: new Date(NaN), values: [0] })).toThrow();
});

test("IN resolves a nested field once per row and does not read it for an empty set", () => {
    let reads = 0;
    const row = {
        get nested() {
            reads++;
            return { value: "match" };
        },
    };
    expect(matches(row, { op: "in", left: field, values: [] })).toBe(false);
    expect(reads).toBe(0);
    expect(matches(row, { op: "in", left: field, values: ["one", "two", "match"] })).toBe(true);
    expect(reads).toBe(1);
    expect(matches(row, { op: "in", left: field, values: ["one", "two", "three"] })).toBe(false);
    expect(reads).toBe(2);
});
