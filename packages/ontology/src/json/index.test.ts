import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { decode, encode } from "./index.js";
import type { OntologyIR } from "../ir/generated/types.js";

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
            ],
            logic: [],
        },
    ],
    queryTypes: [
        {
            name: "getPost",
            displayName: "Get post",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            returnType: o.ref({ name: "Metadata" }),
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

    it("encodes and decodes action and query parameter objects by name", () => {
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
                target: { kind: "queryReturn", queryType: "getPost" },
                value: encoded,
            })
        ).toEqual(value);
    });
});
