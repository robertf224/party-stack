import { o, type OntologyIR } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import {
    decodeCloudKitObject,
    encodeCloudKitObject,
} from "./codec.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Place",
            displayName: "Place",
            pluralDisplayName: "Places",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "location",
                    displayName: "Location",
                    type: o.geopoint({}),
                },
                {
                    name: "tags",
                    displayName: "Tags",
                    type: o.list({
                        elementType: o.string({}),
                    }),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("CloudKit ontology codec", () => {
    it("maps geopoints to locations and lists compositionally", () => {
        const record = encodeCloudKitObject({
            ir,
            objectType: "Place",
            primaryKey: "id",
            zone: { zoneName: "party-stack" },
            object: {
                id: "place-1",
                location: { lat: 40.7, lon: -74 },
                tags: ["city", "coast"],
            },
        });

        expect(record.fields.ps_location).toEqual({
            type: "location",
            value: {
                latitude: 40.7,
                longitude: -74,
            },
        });
        expect(record.fields.ps_tags).toEqual({
            type: "list",
            value: [
                { type: "string", value: "city" },
                { type: "string", value: "coast" },
            ],
        });
        expect(
            decodeCloudKitObject({
                ir,
                objectType: "Place",
                record,
            })
        ).toEqual({
            id: "place-1",
            location: { lat: 40.7, lon: -74 },
            tags: ["city", "coast"],
        });
    });
});
