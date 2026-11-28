import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { cloneDefinition } from "./clone.js";

test("copies a definition's structure but keeps its literal values", () => {
    const day = Temporal.PlainDate.from("2025-11-20");
    const source = {
        parameters: [{ name: "submitted", defaultValue: { kind: "literal", value: { value: day } } }],
    };
    const copy = cloneDefinition(source);
    expect(copy).toEqual(source);
    expect(copy.parameters).not.toBe(source.parameters);
    expect(copy.parameters[0]!.defaultValue).not.toBe(source.parameters[0]!.defaultValue);
    // structuredClone would leave an empty object here.
    expect(copy.parameters[0]!.defaultValue.value.value).toBe(day);
    expect(structuredClone(source).parameters[0]!.defaultValue.value.value).not.toBeInstanceOf(
        Temporal.PlainDate
    );
});

test("copies maps, sets and dates, and keeps null prototypes", () => {
    const source = Object.assign(Object.create(null) as Record<string, unknown>, {
        tags: new Set(["a"]),
        index: new Map([["a", { n: 1 }]]),
        at: new Date(0),
    });
    const copy = cloneDefinition(source);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(copy.tags).not.toBe(source.tags);
    expect(copy.index).toEqual(source.index);
    expect((copy.index as Map<string, object>).get("a")).not.toBe(
        (source.index as Map<string, object>).get("a")
    );
    expect(copy.at).toEqual(source.at);
    expect(copy.at).not.toBe(source.at);
});
