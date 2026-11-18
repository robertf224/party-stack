import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { decode, decodeUnknown, encode, encodeUnknown } from "./index.js";
import type { OntologyIR } from "../ir/generated/types.js";

it("round-trips Temporal inside portable Results/unions and forwards only encrypted handles", () => {
    const nested: OntologyIR = {
        ...ir,
        types: [
            ...ir.types,
            {
                name: "Nested",
                type: o.result({
                    okType: o.union({
                        variants: [
                            {
                                name: "dated",
                                type: o.struct({
                                    fields: [
                                        { name: "created", displayName: "Created", type: o.timestamp({}) },
                                        {
                                            name: "dates",
                                            displayName: "Dates",
                                            type: o.list({ elementType: o.date({}) }),
                                        },
                                        {
                                            name: "secret",
                                            displayName: "Secret",
                                            type: o.encrypted({ type: o.timestamp({}) }),
                                        },
                                    ],
                                }),
                            },
                        ],
                    }),
                    errType: o.timestamp({}),
                }),
            },
        ],
    };
    const value = {
        kind: "ok",
        value: {
            kind: "dated",
            value: {
                created: Temporal.Instant.from("2026-10-19T12:00:00.123456789Z"),
                dates: [Temporal.PlainDate.from("2026-10-19")],
                secret: {
                    ciphertext: "opaque",
                    plaintext: "must not be forwarded",
                    source: {
                        objectType: "Note",
                        primaryKey: "one",
                        property: "secret",
                        plaintext: "must not be forwarded",
                    },
                },
            },
        },
    };
    const encoded = encode({ ir: nested, target: { kind: "type", name: "Nested" }, value });
    expect(JSON.stringify(encoded)).not.toContain("must not be forwarded");
    expect(encoded).toEqual({
        kind: "ok",
        value: {
            kind: "dated",
            value: {
                created: "2026-10-19T12:00:00.123456789Z",
                dates: ["2026-10-19"],
                secret: {
                    ciphertext: "opaque",
                    source: { objectType: "Note", primaryKey: "one", property: "secret" },
                },
            },
        },
    });
    expect(decode({ ir: nested, target: { kind: "type", name: "Nested" }, value: encoded })).toEqual({
        ...value,
        value: {
            ...value.value,
            value: {
                ...value.value.value,
                secret: {
                    ciphertext: "opaque",
                    source: { objectType: "Note", primaryKey: "one", property: "secret" },
                },
            },
        },
    });
    expect(
        decode({
            ir: nested,
            target: { kind: "type", name: "Nested" },
            value: { kind: "err", value: "2026-10-19T12:00:00Z" },
        })
    ).toEqual({ kind: "err", value: Temporal.Instant.from("2026-10-19T12:00:00Z") });
});

const ir = {
    types: [
        {
            name: "Metadata",
            type: o.struct({
                fields: [
                    { name: "publishedOn", displayName: "Published On", type: o.date({}) },
                    { name: "tags", displayName: "Tags", type: o.list({ elementType: o.string({}) }) },
                ],
            }),
        },
    ],
    objectTypes: [
        {
            name: "Post",
            displayName: "Post",
            pluralDisplayName: "Posts",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "createdAt", displayName: "Created At", type: o.timestamp({}) },
                { name: "metadata", displayName: "Metadata", type: o.ref({ name: "Metadata" }) },
                { name: "subtitle", displayName: "Subtitle", type: o.optional({ type: o.string({}) }) },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createPost",
            displayName: "Create post",
            parameters: [
                { name: "metadata", displayName: "Metadata", type: o.ref({ name: "Metadata" }) },
                { name: "subtitle", displayName: "Subtitle", type: o.optional({ type: o.string({}) }) },
            ],
            logic: [],
        },
    ],
    queryFunctionTypes: [
        {
            name: "getPost",
            displayName: "Get post",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            returnType: o.optional({ type: o.ref({ name: "Metadata" }) }),
        },
    ],
} as const satisfies OntologyIR;

describe("ontology JSON codec", () => {
    it("encodes and decodes named types", () => {
        const value = {
            publishedOn: Temporal.PlainDate.from("2026-06-09"),
            tags: ["ontology"],
        };

        const encoded = encode({ ir, target: { kind: "type", name: "Metadata" }, value });
        expect(encoded).toEqual({
            publishedOn: "2026-06-09",
            tags: ["ontology"],
        });

        expect(decode({ ir, target: { kind: "type", name: "Metadata" }, value: encoded })).toEqual(value);
    });

    it("encodes and decodes objects by object type name", () => {
        const object = {
            id: "post-1",
            createdAt: Temporal.Instant.from("2026-06-09T12:00:00Z"),
            metadata: {
                publishedOn: Temporal.PlainDate.from("2026-06-09"),
                tags: ["ontology"],
            },
        };

        const encoded = encode({ ir, target: { kind: "object", name: "Post" }, value: object });
        expect(encoded).toEqual({
            id: "post-1",
            createdAt: "2026-06-09T12:00:00Z",
            metadata: {
                publishedOn: "2026-06-09",
                tags: ["ontology"],
            },
        });

        expect(decode({ ir, target: { kind: "object", name: "Post" }, value: encoded })).toEqual(object);
    });

    it("normalizes optional nulls on object reads while preserving action nulls", () => {
        expect(
            decode({
                ir,
                target: { kind: "object", name: "Post" },
                value: { id: "post-1", subtitle: null },
            })
        ).toEqual({ id: "post-1", subtitle: undefined });

        expect(
            decode({
                ir,
                target: { kind: "actionParameters", actionType: "createPost" },
                value: { subtitle: null },
            })
        ).toEqual({ subtitle: null });
    });

    it("encodes and decodes action and query function parameter objects by name", () => {
        const value = {
            metadata: {
                publishedOn: Temporal.PlainDate.from("2026-06-09"),
                tags: ["ontology"],
            },
        };
        const encoded = {
            metadata: {
                publishedOn: "2026-06-09",
                tags: ["ontology"],
            },
        };

        expect(
            encode({
                ir,
                target: { kind: "actionParameters", actionType: "createPost" },
                value,
            })
        ).toEqual(encoded);
        expect(
            decode({
                ir,
                target: { kind: "actionParameters", actionType: "createPost" },
                value: encoded,
            })
        ).toEqual(value);
    });

    it("encodes and decodes single query targets by name", () => {
        const value = {
            publishedOn: Temporal.PlainDate.from("2026-06-09"),
            tags: ["ontology"],
        };
        const encoded = {
            publishedOn: "2026-06-09",
            tags: ["ontology"],
        };

        expect(
            decode({
                ir,
                target: { kind: "queryFunctionReturn", queryFunctionType: "getPost" },
                value: encoded,
            })
        ).toEqual(value);
        expect(
            decode({
                ir,
                target: { kind: "queryFunctionReturn", queryFunctionType: "getPost" },
                value: null,
            })
        ).toBeUndefined();
    });
});

describe("unknown values", () => {
    const roundTrip = (value: unknown) => decodeUnknown(JSON.parse(JSON.stringify(encodeUnknown(value))));

    it("keeps JSON-native values, strings included, as they are", () => {
        const value = {
            name: "2026-01-01",
            n: 1.5,
            ok: true,
            none: null,
            list: [1, "a", { nested: [false] }],
        };
        expect(encodeUnknown(value)).toEqual(value);
        expect(roundTrip(value)).toEqual(value);
    });

    it("writes dates and timestamps with their type so they come back as Temporal values", () => {
        const instant = Temporal.Instant.from("2026-01-01T12:30:00Z");
        const date = Temporal.PlainDate.from("2026-01-01");
        expect(encodeUnknown({ at: instant, on: [date] })).toEqual({
            at: { $type: "timestamp", value: "2026-01-01T12:30:00Z" },
            on: [{ $type: "date", value: "2026-01-01" }],
        });
        const back = roundTrip({ at: instant, on: [date] }) as {
            at: Temporal.Instant;
            on: [Temporal.PlainDate];
        };
        expect(back.at).toBeInstanceOf(Temporal.Instant);
        expect(back.at.equals(instant)).toBe(true);
        expect(back.on[0]).toBeInstanceOf(Temporal.PlainDate);
        expect(back.on[0].equals(date)).toBe(true);
    });

    it("reads any scalar written with its type, though only dates and timestamps are written that way", () => {
        expect(decodeUnknown({ $type: "string", value: "x" })).toBe("x");
        expect(decodeUnknown({ $type: "integer", value: 5 })).toBe(5);
        expect(decodeUnknown({ $type: "double", value: 1.5 })).toBe(1.5);
        expect(decodeUnknown({ $type: "boolean", value: false })).toBe(false);
        expect(() => decodeUnknown({ $type: "integer", value: "5" })).toThrow();
        expect(() => decodeUnknown({ $type: "list", value: [] })).toThrow();
    });

    it("reserves $type", () => {
        expect(() => encodeUnknown({ $type: "mine", other: 1 })).toThrow(/reserved/);
        expect(() => encodeUnknown([{ nested: { $type: "x" } }])).toThrow(/reserved/);
    });

    it("reads JSON written before $type as itself", () => {
        const old = {
            where: { kind: "gt", value: { right: { kind: "literal", value: { value: "2026-01-01" } } } },
        };
        expect(decodeUnknown(old)).toEqual(old);
    });

    it("round-trips unknown positions through the typed codec", () => {
        const withUnknown: OntologyIR = {
            ...ir,
            types: [
                ...ir.types,
                {
                    name: "Bag",
                    type: o.struct({
                        fields: [{ name: "anything", displayName: "Anything", type: o.unknown({}) }],
                    }),
                },
            ],
        };
        const target = { kind: "type", name: "Bag" } as const;
        const at = Temporal.Instant.from("2026-01-01T00:00:00Z");
        const json = JSON.parse(
            JSON.stringify(encode({ ir: withUnknown, target, value: { anything: { at } } }))
        );
        expect(json).toEqual({ anything: { at: { $type: "timestamp", value: "2026-01-01T00:00:00Z" } } });
        const back = decode({ ir: withUnknown, target, value: json }) as {
            anything: { at: Temporal.Instant };
        };
        expect(back.anything.at.equals(at)).toBe(true);
    });
});
