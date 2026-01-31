import { describe, expect, it } from "vitest";
import { validate, ValidationResult } from "./index.js";
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
                    name: "Address",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "line1",
                                    displayName: "line1",
                                    type: { kind: "string", value: {} },
                                },
                                {
                                    name: "city",
                                    displayName: "city",
                                    type: { kind: "string", value: {} },
                                },
                            ],
                        },
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
                    name: "Address",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "city",
                                    displayName: "city",
                                    type: { kind: "string", value: {} },
                                },
                            ],
                        },
                    },
                },
                {
                    name: "Order",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "shipTo",
                                    displayName: "Ship To",
                                    type: { kind: "ref", value: { name: "Address" } },
                                },
                            ],
                        },
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
                    name: "Order",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "shipTo",
                                    displayName: "Ship To",
                                    type: { kind: "ref", value: { name: "Unknown" } },
                                },
                            ],
                        },
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
                { name: "Address", type: { kind: "struct", value: { fields: [] } } },
                { name: "Address", type: { kind: "struct", value: { fields: [] } } },
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
                    name: "Item",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "name",
                                    displayName: "name",
                                    type: { kind: "string", value: {} },
                                },
                            ],
                        },
                    },
                },
                {
                    name: "Order",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "items",
                                    displayName: "Items",
                                    type: {
                                        kind: "list",
                                        value: {
                                            elementType: { kind: "ref", value: { name: "Item" } },
                                        },
                                    },
                                },
                            ],
                        },
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
                    name: "Shape",
                    type: {
                        kind: "union",
                        value: {
                            variants: [
                                {
                                    name: "circle",
                                    type: {
                                        kind: "struct",
                                        value: {
                                            fields: [
                                                {
                                                    name: "radius",
                                                    displayName: "radius",
                                                    type: { kind: "double", value: {} },
                                                },
                                            ],
                                        },
                                    },
                                },
                                {
                                    name: "rectangle",
                                    type: {
                                        kind: "struct",
                                        value: {
                                            fields: [
                                                {
                                                    name: "width",
                                                    displayName: "width",
                                                    type: { kind: "double", value: {} },
                                                },
                                                {
                                                    name: "height",
                                                    displayName: "height",
                                                    type: { kind: "double", value: {} },
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });

    it("should validate maps with string key types", () => {
        const schema: SchemaIR = {
            types: [
                {
                    name: "Metadata",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "tags",
                                    displayName: "Tags",
                                    type: {
                                        kind: "map",
                                        value: {
                                            keyType: { kind: "string", value: {} },
                                            valueType: { kind: "string", value: {} },
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });

    it("should detect non-string map key types", () => {
        const schema: SchemaIR = {
            types: [
                {
                    name: "Metadata",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "scores",
                                    displayName: "Scores",
                                    type: {
                                        kind: "map",
                                        value: {
                                            keyType: { kind: "integer", value: {} },
                                            valueType: { kind: "double", value: {} },
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
        };

        const result = validate(schema);
        expectErr(result, 1);
        expect(getErrors(result)).toContain("Map key types must be string.");
    });

    it("should validate optional wrapper types", () => {
        const schema: SchemaIR = {
            types: [
                {
                    name: "User",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                {
                                    name: "name",
                                    displayName: "Name",
                                    type: { kind: "string", value: {} },
                                },
                                {
                                    name: "nickname",
                                    displayName: "Nickname",
                                    type: {
                                        kind: "optional",
                                        value: { type: { kind: "string", value: {} } },
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
        };

        expectOk(validate(schema));
    });
});
