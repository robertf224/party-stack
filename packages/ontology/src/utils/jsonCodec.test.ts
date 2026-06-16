import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import {
    hydrateOntologyJsonObject,
    hydrateOntologyJsonValue,
    serializeOntologyJsonObject,
    serializeOntologyJsonValue,
} from "./jsonCodec.js";
import type { OntologyIR } from "../ir/generated/types.js";

const ir: OntologyIR = {
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
    actionTypes: [],
    queryTypes: [],
};

describe("ontology JSON codec", () => {
    it("serializes and hydrates typed values", () => {
        const type = o.map({
            keyType: o.string({}),
            valueType: o.optional({ type: o.timestamp({}) }),
        });
        const instant = Temporal.Instant.from("2026-06-09T12:00:00Z");

        const serialized = serializeOntologyJsonValue(ir, type, { lastSeen: instant });
        expect(serialized).toEqual({ lastSeen: "2026-06-09T12:00:00Z" });

        const hydrated = hydrateOntologyJsonValue(ir, type, serialized);
        expect(hydrated).toEqual({ lastSeen: instant });
    });

    it("serializes and hydrates objects by object type", () => {
        const object = {
            id: "post-1",
            createdAt: Temporal.Instant.from("2026-06-09T12:00:00Z"),
            metadata: {
                publishedOn: Temporal.PlainDate.from("2026-06-09"),
                tags: ["ontology"],
            },
        };

        const serialized = serializeOntologyJsonObject({ ir, objectTypeName: "Post", object });
        expect(serialized).toEqual({
            id: "post-1",
            createdAt: "2026-06-09T12:00:00Z",
            metadata: {
                publishedOn: "2026-06-09",
                tags: ["ontology"],
            },
        });

        expect(hydrateOntologyJsonObject({ ir, objectTypeName: "Post", object: serialized })).toEqual(object);
    });
});
