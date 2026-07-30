import { describe, expect, it } from "vitest";
import { convertFoundryMetaQueryFunctionType } from "./convertMetaQueryFunctionType.js";
import type { QueryTypeV2 } from "@osdk/foundry.ontologies";

function queryType(
    parameters: QueryTypeV2["parameters"],
    output: QueryTypeV2["output"]
): QueryTypeV2 {
    return {
        apiName: "googleMapsAutocompleteAddress",
        displayName: "googleMapsAutocompleteAddress",
        parameters,
        output,
        rid: "ri.function-registry.main.function.example",
        version: "1.0.0",
        typeReferences: {},
    };
}

describe("convertFoundryMetaQueryFunctionType", () => {
    it("collapses nullable optional parameters without double wrapping", () => {
        const result = convertFoundryMetaQueryFunctionType(
            queryType(
                {
                    apiKey: {
                        dataType: {
                            type: "union",
                            unionTypes: [{ type: "string" }, { type: "null" }],
                        },
                        required: false,
                    },
                    countries: {
                        dataType: {
                            type: "union",
                            unionTypes: [
                                { type: "array", subType: { type: "string" } },
                                { type: "null" },
                            ],
                        },
                        required: false,
                    },
                },
                { type: "void" }
            )
        );

        expect(result.parameters.map(({ type }) => type)).toEqual([
            {
                kind: "optional",
                value: { type: { kind: "string", value: {} } },
            },
            {
                kind: "optional",
                value: {
                    type: {
                        kind: "list",
                        value: { elementType: { kind: "string", value: {} } },
                    },
                },
            },
        ]);
    });

    it("collapses nullable struct fields recursively", () => {
        const result = convertFoundryMetaQueryFunctionType(
            queryType(
                {},
                {
                    type: "struct",
                    fields: [
                        {
                            name: "address",
                            fieldType: {
                                type: "union",
                                unionTypes: [
                                    {
                                        type: "struct",
                                        fields: [
                                            {
                                                name: "address2",
                                                fieldType: {
                                                    type: "union",
                                                    unionTypes: [
                                                        { type: "string" },
                                                        { type: "null" },
                                                    ],
                                                },
                                            },
                                        ],
                                    },
                                    { type: "null" },
                                ],
                            },
                        },
                    ],
                }
            )
        );

        expect(result.returnType).toEqual({
            kind: "struct",
            value: {
                fields: [
                    {
                        name: "address",
                        displayName: "address",
                        type: {
                            kind: "optional",
                            value: {
                                type: {
                                    kind: "struct",
                                    value: {
                                        fields: [
                                            {
                                                name: "address2",
                                                displayName: "address2",
                                                type: {
                                                    kind: "optional",
                                                    value: {
                                                        type: {
                                                            kind: "string",
                                                            value: {},
                                                        },
                                                    },
                                                },
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    },
                ],
            },
        });
    });

    it("preserves unions with multiple non-null variants", () => {
        const result = convertFoundryMetaQueryFunctionType(
            queryType(
                {},
                {
                    type: "union",
                    unionTypes: [{ type: "string" }, { type: "integer" }],
                }
            )
        );

        expect(result.returnType).toEqual({
            kind: "union",
            value: {
                variants: [
                    { name: "variant1", type: { kind: "string", value: {} } },
                    { name: "variant2", type: { kind: "integer", value: {} } },
                ],
            },
        });
    });
});
