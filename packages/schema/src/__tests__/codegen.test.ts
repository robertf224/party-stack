import { describe, expect, it } from "vitest";
import { generateTypeScript, generateZod } from "../codegen/index.js";
import type { SchemaIR } from "../ir/index.js";

describe("Code Generation", () => {
    describe("TypeScript Types", () => {
        it("should generate type for simple struct", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Address",
                        type: {
                            kind: "struct",
                            fields: [
                                { apiName: "city", displayName: "city", type: { kind: "string", required: true } },
                                { apiName: "zip", displayName: "zip", type: { kind: "string" } },
                            ],
                        },
                    },
                ],
            };

            const code = generateTypeScript(schema);

            expect(code).toContain("export type Address");
            expect(code).toContain("readonly city: string");
            expect(code).toContain("readonly zip?: string"); // optional
        });

        it("should generate string enum types", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Order",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "status",
                                    displayName: "status",
                                    type: {
                                        kind: "string",
                                        constraint: {
                                            kind: "enum",
                                            options: [{ value: "pending" }, { value: "active" }, { value: "done" }],
                                        },
                                        required: true,
                                    },
                                },
                            ],
                        },
                    },
                ],
            };

            const code = generateTypeScript(schema);
            expect(code).toContain('"pending" | "active" | "done"');
        });

        it("should generate types with refs as type names", () => {
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

            const code = generateTypeScript(schema);

            // Both types should be generated
            expect(code).toContain("export type Address");
            expect(code).toContain("export type Order");

            // The ref should be emitted as the type name
            expect(code).toContain("readonly shipTo?: Address");
        });

        it("should generate list types", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Order",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "items",
                                    displayName: "items",
                                    type: {
                                        kind: "list",
                                        elementType: { kind: "string" },
                                        required: true,
                                    },
                                },
                            ],
                        },
                    },
                ],
            };

            const code = generateTypeScript(schema);
            expect(code).toContain("readonly items: string[]");
        });
    });

    describe("Zod Schemas", () => {
        it("should generate zod schema for simple struct", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Address",
                        type: {
                            kind: "struct",
                            fields: [
                                { apiName: "city", displayName: "city", type: { kind: "string", required: true } },
                                { apiName: "zip", displayName: "zip", type: { kind: "string" } },
                            ],
                        },
                    },
                ],
            };

            const code = generateZod(schema);

            expect(code).toContain('import { z } from "zod"');
            expect(code).toContain("export const AddressSchema");
            expect(code).toContain("z.object({");
            expect(code).toContain("city: z.string()");
            expect(code).toContain("zip: z.string().optional()");
        });

        it("should generate zod enum for string enums", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Order",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "status",
                                    displayName: "status",
                                    type: {
                                        kind: "string",
                                        constraint: {
                                            kind: "enum",
                                            options: [{ value: "pending" }, { value: "active" }],
                                        },
                                        required: true,
                                    },
                                },
                            ],
                        },
                    },
                ],
            };

            const code = generateZod(schema);
            expect(code).toContain('z.enum(["pending", "active"])');
        });

        it("should generate refs as schema references", () => {
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

            const code = generateZod(schema);

            // Refs are emitted as schema references
            expect(code).toContain("AddressSchema.optional()");
        });

        it("should generate inferred types", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Address",
                        type: {
                            kind: "struct",
                            fields: [
                                { apiName: "city", displayName: "city", type: { kind: "string" } },
                            ],
                        },
                    },
                ],
            };

            const code = generateZod(schema);
            expect(code).toContain("export type Address = z.infer<typeof AddressSchema>");
        });
    });
});
