import { o, type OntologyIR } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import { generateCloudKitSchema } from "./schema.js";

describe("generateCloudKitSchema", () => {
    it("includes ontology and Party Stack system records", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Journal Entry",
                    displayName: "Journal Entry",
                    pluralDisplayName: "Journal Entries",
                    primaryKey: "id",
                    properties: [
                        {
                            name: "id",
                            displayName: "ID",
                            type: o.string({}),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        };

        const schema = generateCloudKitSchema(ir);

        expect(schema).toContain(
            "RECORD TYPE PS_Journal_x20_Entry"
        );
        expect(schema).toContain("ps_id STRING");
        expect(schema).toContain(
            "RECORD TYPE PS_PartyStackAttachment"
        );
        expect(schema).toContain("asset ASSET");
        expect(schema).toContain(
            "RECORD TYPE PS_PartyStackActionReceipt"
        );
    });
});
