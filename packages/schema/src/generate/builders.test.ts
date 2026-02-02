import { describe, expect, it } from "vitest";
import { generateBuilders } from "./index.js";
import type { SchemaIR } from "../ir/index.js";

describe("Builders generation", () => {
    describe("Union Type Factories", () => {
        it("should generate factory functions for union variants", () => {
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
                                        type: { kind: "ref", value: { name: "CircleDef" } },
                                    },
                                    {
                                        name: "square",
                                        type: { kind: "ref", value: { name: "SquareDef" } },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateBuilders(schema, { exportName: "p" })).toMatchInlineSnapshot(`
              "import { type Shape } from "./schema.js";

              export const Shape = { circle: (value: Extract<Shape, { kind: "circle" }>["value"]) => ({ kind: "circle" as const, value }), square: (value: Extract<Shape, { kind: "square" }>["value"]) => ({ kind: "square" as const, value }) };
              export const p = { Shape };"
            `);
        });

        it("should promote union variants to top level when specified", () => {
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
                                        type: { kind: "ref", value: { name: "CircleDef" } },
                                    },
                                    {
                                        name: "square",
                                        type: { kind: "ref", value: { name: "SquareDef" } },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateBuilders(schema, { exportName: "p", promoted: "Shape" })).toMatchInlineSnapshot(`
              "import { type Shape } from "./schema.js";

              export const circle = (value: Extract<Shape, { kind: "circle" }>["value"]) => ({ kind: "circle" as const, value });
              export const square = (value: Extract<Shape, { kind: "square" }>["value"]) => ({ kind: "square" as const, value });
              export const p = { circle, square };"
            `);
        });

        it("should handle multiple unions with one promoted", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "TypeDef",
                        type: {
                            kind: "union",
                            value: {
                                variants: [
                                    {
                                        name: "string",
                                        type: { kind: "ref", value: { name: "StringTypeDef" } },
                                    },
                                    {
                                        name: "boolean",
                                        type: { kind: "ref", value: { name: "BooleanTypeDef" } },
                                    },
                                ],
                            },
                        },
                    },
                    {
                        name: "Constraint",
                        type: {
                            kind: "union",
                            value: {
                                variants: [
                                    {
                                        name: "enum",
                                        type: { kind: "ref", value: { name: "EnumConstraint" } },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            const result = generateBuilders(schema, { exportName: "p", promoted: "TypeDef" });
            expect(result).toContain(
                'export const string = (value: Extract<TypeDef, { kind: "string" }>["value"]) => ({ kind: "string" as const, value })'
            );
            expect(result).toContain(
                'export const boolean = (value: Extract<TypeDef, { kind: "boolean" }>["value"]) => ({ kind: "boolean" as const, value })'
            );
            expect(result).toContain("export const Constraint = {");
            expect(result).toContain(
                'enum: (value: Extract<Constraint, { kind: "enum" }>["value"]) => ({ kind: "enum" as const, value })'
            );
        });

        it("should use custom export name", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "TypeDef",
                        type: {
                            kind: "union",
                            value: {
                                variants: [
                                    {
                                        name: "string",
                                        type: { kind: "ref", value: { name: "StringTypeDef" } },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateBuilders(schema, { exportName: "schema" })).toMatchInlineSnapshot(`
              "import { type TypeDef } from "./schema.js";

              export const TypeDef = { string: (value: Extract<TypeDef, { kind: "string" }>["value"]) => ({ kind: "string" as const, value }) };
              export const schema = { TypeDef };"
            `);
        });
    });

    describe("Self-describing IR", () => {
        it("should generate builders for a TypeDef-like union deriving types from Zod output", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "TypeDef",
                        type: {
                            kind: "union",
                            value: {
                                variants: [
                                    {
                                        name: "string",
                                        type: { kind: "ref", value: { name: "StringTypeDef" } },
                                    },
                                    {
                                        name: "boolean",
                                        type: { kind: "ref", value: { name: "BooleanTypeDef" } },
                                    },
                                    {
                                        name: "integer",
                                        type: { kind: "ref", value: { name: "IntegerTypeDef" } },
                                    },
                                    {
                                        name: "list",
                                        type: { kind: "ref", value: { name: "ListTypeDef" } },
                                    },
                                    {
                                        name: "struct",
                                        type: { kind: "ref", value: { name: "StructTypeDef" } },
                                    },
                                    {
                                        name: "union",
                                        type: { kind: "ref", value: { name: "UnionTypeDef" } },
                                    },
                                    { name: "ref", type: { kind: "ref", value: { name: "TypeRef" } } },
                                ],
                            },
                        },
                    },
                ],
            };

            const result = generateBuilders(schema, { exportName: "p", promoted: "TypeDef" });

            // Factories derive types from the Zod-generated union using Extract
            expect(result).toContain(
                'export const string = (value: Extract<TypeDef, { kind: "string" }>["value"]) => ({ kind: "string" as const, value })'
            );
            expect(result).toContain(
                'export const list = (value: Extract<TypeDef, { kind: "list" }>["value"]) => ({ kind: "list" as const, value })'
            );
            expect(result).toContain(
                'export const struct = (value: Extract<TypeDef, { kind: "struct" }>["value"]) => ({ kind: "struct" as const, value })'
            );
            expect(result).toContain(
                'export const ref = (value: Extract<TypeDef, { kind: "ref" }>["value"]) => ({ kind: "ref" as const, value })'
            );
        });
    });

    describe("Deprecation", () => {
        it("should include @deprecated tag for deprecated union types", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "LegacyShape",
                        deprecated: { message: "Use Shape instead" },
                        type: {
                            kind: "union",
                            value: {
                                variants: [
                                    {
                                        name: "circle",
                                        type: { kind: "ref", value: { name: "CircleDef" } },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            const result = generateBuilders(schema, { exportName: "p" });
            expect(result).toContain("@deprecated Use Shape instead");
        });

        it("should include @deprecated tag for promoted deprecated union type variants", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Shape",
                        deprecated: { message: "Use NewShape instead" },
                        type: {
                            kind: "union",
                            value: {
                                variants: [
                                    {
                                        name: "circle",
                                        type: { kind: "ref", value: { name: "CircleDef" } },
                                    },
                                    {
                                        name: "square",
                                        type: { kind: "ref", value: { name: "SquareDef" } },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            const result = generateBuilders(schema, { exportName: "p", promoted: "Shape" });
            expect(result).toContain("@deprecated Use NewShape instead");
            // Each promoted variant should have the deprecation tag
            expect(result.match(/@deprecated/g)?.length).toBe(2);
        });
    });
});
