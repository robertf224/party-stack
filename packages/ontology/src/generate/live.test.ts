import { describe, expect, it } from "vitest";
import { generateLive } from "./live.js";

describe("generateLive", () => {
    it("combines runtime value and type imports", () => {
        const output = generateLive(
            {
                types: [],
                objectTypes: [],
                linkTypes: [],
                actionTypes: [],
                queryFunctionTypes: [],
            },
            {
                ontologyImportPath:
                    "../ontology.js",
                ontologyTypesImportPath:
                    "./types.js",
                ontologyRuntimeImportPath:
                    "@party-stack/ontology",
                ontologyTypeName: "ExampleOntology",
                outputFactoryName:
                    "createExampleLiveOntology",
            }
        );

        expect(output).toContain(
            'import { createLiveOntology, type CreateLiveOntologyOpts, type LiveOntology } from "@party-stack/ontology";'
        );
        expect(
            output.match(
                /from "@party-stack\/ontology";/g
            )
        ).toHaveLength(1);
    });
});
