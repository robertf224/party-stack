import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { decode, encode } from "./index.js";
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
