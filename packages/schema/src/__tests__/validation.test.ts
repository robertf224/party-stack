import { describe, expect, it } from "vitest";
import { validate, ValidationResult } from "../validation/index.js";
import type { SchemaIR } from "../ir/index.js";

function expectOk(result: ValidationResult): void {
    expect(result.kind).toBe("ok");
}

function expectErr(result: ValidationResult, count?: number): void {
    expect(result.kind).toBe("err");
    if (result.kind === "err" && count !== undefined) {
        expect(result.errors).toHaveLength(count);
    }
}

function getErrors(result: ValidationResult): string[] {
    return result.kind === "ok" ? [] : result.errors.map((e) => e.message);
}

describe("Schema Validation", () => {
    it("should validate a simple struct", () => {
        const schema: SchemaIR = {
            types: [
                {
                    apiName: "Address",
                    type: {
                        kind: "struct",
                        fields: [
                            { apiName: "line1", displayName: "line1", type: { kind: "string", required: true } },
                            { apiName: "city", displayName: "city", type: { kind: "string", required: true } },
                        ],
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });

    it("should validate type references", () => {
        const schema: SchemaIR = {
            types: [
                {
                    apiName: "Address",
                    type: {
                        kind: "struct",
                        fields: [
                            { apiName: "city", displayName: "city", type: { kind: "string", required: true } },
                        ],
                    },
                },
                {
                    apiName: "Order",
                    type: {
                        kind: "struct",
                        fields: [
                            {
                                apiName: "shipTo",
                                displayName: "Ship To",
                                type: { kind: "ref", apiName: "Address" },
                            },
                        ],
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });

    it("should detect unknown type references", () => {
        const schema: SchemaIR = {
            types: [
                {
                    apiName: "Order",
                    type: {
                        kind: "struct",
                        fields: [
                            {
                                apiName: "shipTo",
                                displayName: "Ship To",
                                type: { kind: "ref", apiName: "Unknown" },
                            },
                        ],
                    },
                },
            ],
        };

        const result = validate(schema);
        expectErr(result, 1);
        expect(getErrors(result)).toContain("Unknown type reference.");
    });

    it("should detect duplicate type names", () => {
        const schema: SchemaIR = {
            types: [
                { apiName: "Address", type: { kind: "struct", fields: [] } },
                { apiName: "Address", type: { kind: "struct", fields: [] } },
            ],
        };

        const result = validate(schema);
        expectErr(result);
        expect(getErrors(result)).toContain("Duplicate type name.");
    });

    it("should validate nested lists with refs", () => {
        const schema: SchemaIR = {
            types: [
                {
                    apiName: "Item",
                    type: {
                        kind: "struct",
                        fields: [
                            { apiName: "name", displayName: "name", type: { kind: "string", required: true } },
                        ],
                    },
                },
                {
                    apiName: "Order",
                    type: {
                        kind: "struct",
                        fields: [
                            {
                                apiName: "items",
                                displayName: "Items",
                                type: {
                                    kind: "list",
                                    elementType: { kind: "ref", apiName: "Item" },
                                    required: true,
                                },
                            },
                        ],
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });

    it("should validate unions", () => {
        const schema: SchemaIR = {
            types: [
                {
                    apiName: "Shape",
                    type: {
                        kind: "union",
                        variants: [
                            {
                                apiName: "circle",
                                type: {
                                    kind: "struct",
                                    fields: [
                                        { apiName: "radius", displayName: "radius", type: { kind: "double", required: true } },
                                    ],
                                },
                            },
                            {
                                apiName: "rectangle",
                                type: {
                                    kind: "struct",
                                    fields: [
                                        { apiName: "width", displayName: "width", type: { kind: "double", required: true } },
                                        { apiName: "height", displayName: "height", type: { kind: "double", required: true } },
                                    ],
                                },
                            },
                        ],
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });
});
