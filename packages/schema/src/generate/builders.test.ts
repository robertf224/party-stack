import { describe, expect, it } from "vitest";
import { generateBuilders } from "./index.js";
import type { SchemaIR } from "../ir/index.js";

describe("Builders generation", () => {
    describe("Union Type Factories", () => {
        it("should generate factory functions for union variants", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Shape",
                        type: {
                            kind: "union",
                            variants: [
                                { apiName: "circle", type: { kind: "ref", apiName: "CircleDef" } },
                                { apiName: "square", type: { kind: "ref", apiName: "SquareDef" } },
                            ],
                        },
                    },
                ],
            };

            expect(generateBuilders(schema, { exportName: "p" })).toMatchInlineSnapshot(`
              "export const Shape = { circle: (value: Extract<Shape, { kind: circle }>["value"]) => ({ kind: "circle" as const, value }), square: (value: Extract<Shape, { kind: square}>["value"]) => ({ kind: "square" as const, value }) };
              export const p = { Shape };"
            `);
        });

        it("should promote union variants to top level when specified", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Shape",
                        type: {
                            kind: "union",
                            variants: [
                                { apiName: "circle", type: { kind: "ref", apiName: "CircleDef" } },
                                { apiName: "square", type: { kind: "ref", apiName: "SquareDef" } },
                            ],
                        },
                    },
                ],
            };

            expect(generateBuilders(schema, { exportName: "p", promoted: "Shape" })).toMatchInlineSnapshot(`
              "export const circle = (value: Extract<Shape, { kind: circle }>["value"]) => ({ kind: "circle" as const, value });
              export const square = (value: Extract<Shape, { kind: square }>["value"]) => ({ kind: "square" as const, value });
              export const p = { circle, square };"
            `);
        });

        it("should handle multiple unions with one promoted", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "TypeDef",
                        type: {
                            kind: "union",
                            variants: [
                                { apiName: "string", type: { kind: "ref", apiName: "StringTypeDef" } },
                                { apiName: "boolean", type: { kind: "ref", apiName: "BooleanTypeDef" } },
                            ],
                        },
                    },
                    {
                        apiName: "Constraint",
                        type: {
                            kind: "union",
                            variants: [{ apiName: "enum", type: { kind: "ref", apiName: "EnumConstraint" } }],
                        },
                    },
                ],
            };

            const result = generateBuilders(schema, { exportName: "p", promoted: "TypeDef" });
            expect(result).toContain(
                'export const string = (value: Extract<TypeDef, { kind: string }>["value"]) => ({ kind: "string" as const, value })'
            );
            expect(result).toContain(
                'export const boolean = (value: Extract<TypeDef, { kind: boolean }>["value"]) => ({ kind: "boolean" as const, value })'
            );
            expect(result).toContain("export const Constraint = {");
            expect(result).toContain(
                'enum: (value: Extract<Constraint, { kind: enum }>["value"]) => ({ kind: "enum" as const, value })'
            );
        });

        it("should use custom export name", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "TypeDef",
                        type: {
                            kind: "union",
                            variants: [
                                { apiName: "string", type: { kind: "ref", apiName: "StringTypeDef" } },
                            ],
                        },
                    },
                ],
            };

            expect(generateBuilders(schema, { exportName: "schema" })).toMatchInlineSnapshot(`
              "export const TypeDef = { string: (value: Extract<TypeDef, { kind: string }>["value"]) => ({ kind: "string" as const, value }) };
              export const schema = { TypeDef };"
            `);
        });
    });

    describe("Self-describing IR", () => {
        it("should generate builders for a TypeDef-like union deriving types from Zod output", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "TypeDef",
                        type: {
                            kind: "union",
                            variants: [
                                { apiName: "string", type: { kind: "ref", apiName: "StringTypeDef" } },
                                { apiName: "boolean", type: { kind: "ref", apiName: "BooleanTypeDef" } },
                                { apiName: "integer", type: { kind: "ref", apiName: "IntegerTypeDef" } },
                                { apiName: "list", type: { kind: "ref", apiName: "ListTypeDef" } },
                                { apiName: "struct", type: { kind: "ref", apiName: "StructTypeDef" } },
                                { apiName: "union", type: { kind: "ref", apiName: "UnionTypeDef" } },
                                { apiName: "ref", type: { kind: "ref", apiName: "TypeRef" } },
                            ],
                        },
                    },
                ],
            };

            const result = generateBuilders(schema, { exportName: "p", promoted: "TypeDef" });

            // Factories derive types from the Zod-generated union using Extract
            expect(result).toContain(
                'export const string = (value: Extract<TypeDef, { kind: string }>["value"]) => ({ kind: "string" as const, value })'
            );
            expect(result).toContain(
                'export const list = (value: Extract<TypeDef, { kind: list }>["value"]) => ({ kind: "list" as const, value })'
            );
            expect(result).toContain(
                'export const struct = (value: Extract<TypeDef, { kind: struct }>["value"]) => ({ kind: "struct" as const, value })'
            );
            expect(result).toContain(
                'export const ref = (value: Extract<TypeDef, { kind: ref }>["value"]) => ({ kind: "ref" as const, value })'
            );
        });
    });
});
