import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import type { OntologyIR } from "../ir/generated/types.js";
import { generateOntology } from "./ontology.js";

describe("generateOntology", () => {
    it("renders property metadata as object literals", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "User",
                    displayName: "User",
                    pluralDisplayName: "Users",
                    primaryKey: "userId",
                    properties: [
                        {
                            name: "userId",
                            displayName: "User ID",
                            type: o.string({}),
                            meta: {
                                source: "foundry",
                                version: 2,
                            },
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
        };

        const output = generateOntology(ontology);
        const normalizedOutput = output.replace(/\s+/g, " ");

        expect(normalizedOutput).toContain('meta: { source: "foundry", version: 2, },');
    });
});
