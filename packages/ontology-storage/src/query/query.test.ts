import { expect, test } from "vitest";
import {
    and,
    eq,
    field,
    ilike,
    inArray,
    isNull,
    isUndefined,
    like,
    not,
    or,
    lt,
    gt,
    isField,
} from "../table-api.js";
import { matches, matchLike } from "./evaluate.js";

test("LIKE and ILIKE follow TanStack's wildcard and JS lowercase semantics", () => {
    for (const [value, pattern, expected] of [
        ["abc", "a_c", true],
        ["abc", "a%", true],
        ["abc", "a_d", false],
        ["", "%", true],
        ["", "_", false],
        ["a\nb", "a%b", true],
        ["a.b[", "a.b[", true],
        ["axb", "a.b", false],
        ["a\\bc", "a\\%", true],
        ["abc", "a\\%", false],
        ["😀", "_", false],
        ["😀", "__", true],
    ] as const)
        expect(matchLike(value, pattern, false), `${value} LIKE ${pattern}`).toBe(expected);
    expect(matches({ name: "PrÉFix" }, ilike(field("name"), "préf%"))).toBe(true);
    expect(matches({ name: "İstanbul" }, ilike(field("name"), "İS%"))).toBe(true);
    expect(matches({ name: null }, like(field("name"), "%"))).toBe(false);
    expect(matches({ name: "Prefix" }, like(field("name"), "prefix%"))).toBe(false);
    expect(matchLike("a".repeat(200) + "x", "%a".repeat(100) + "b", false)).toBe(false);
});

test("Standalone predicate helpers compose and preserve explicit null/undefined", () => {
    const predicate = and(
        inArray(field("x"), [1, 2]),
        not(eq(field("x"), 1)),
        or(isNull(field("n")), isUndefined(field("n")))
    );
    expect(matches({ x: 2, n: null }, predicate)).toBe(true);
    expect(matches({ x: 2 }, predicate)).toBe(true);
    expect(matches({ x: 1 }, predicate)).toBe(false);
});

test("Wildcard evaluator agrees with an independent dynamic-programming oracle", () => {
    const strings = [""];
    const patterns = [""];
    for (let n = 0; n < 4; n++) {
        for (const prefix of strings.filter((s) => s.length === n))
            for (const c of "ab") strings.push(prefix + c);
        for (const prefix of patterns.filter((s) => s.length === n))
            for (const c of "ab%_") patterns.push(prefix + c);
    }
    for (const value of strings)
        for (const pattern of patterns) {
            let previous = [true, ...Array<boolean>(value.length).fill(false)];
            for (const token of pattern) {
                const next = [token === "%" && previous[0]!, ...Array<boolean>(value.length).fill(false)];
                for (let i = 1; i <= value.length; i++)
                    next[i] =
                        token === "%"
                            ? previous[i]! || next[i - 1]!
                            : previous[i - 1]! && (token === "_" || token === value[i - 1]);
                previous = next;
            }
            expect(matchLike(value, pattern, false), `${value} LIKE ${pattern}`).toBe(previous[value.length]);
        }
});

test("References are explicit and comparisons resolve both operands independently", () => {
    const row = {
        left: 2,
        right: 3,
        name: "left",
        pattern: "l%",
        address: { city: "NY" },
        "address.city": "SF",
    };
    expect(field("left")).toEqual({ _tag: "Field", path: ["left"] });
    expect(isField(field("left"))).toBe(true);
    expect(isField("left")).toBe(false);
    expect(matches(row, eq("left", "left"))).toBe(true);
    expect(matches(row, eq(field("left"), "left"))).toBe(false);
    expect(matches(row, eq("left", field("name")))).toBe(true);
    expect(matches(row, lt(field("left"), field("right")))).toBe(true);
    expect(matches(row, gt(4, field("right")))).toBe(true);
    expect(matches(row, like(field("name"), field("pattern")))).toBe(true);
    expect(matches(row, like("left", field("pattern")))).toBe(true);
    expect(matches(row, eq(field("address.city"), "SF"))).toBe(true);
    expect(matches(row, eq(field("address", "city"), "NY"))).toBe(true);
});
