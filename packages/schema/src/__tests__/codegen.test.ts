import { describe, expect, it } from "vitest";
import { generateZod } from "../generate/index.js";
import type { SchemaIR } from "../ir/index.js";

describe("Zod Schema Generation", () => {
    describe("Conceptual Types", () => {
        it("should generate zod schema for simple struct", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Address",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "city",
                                    displayName: "city",
                                    type: { kind: "string", required: true },
                                },
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
                                {
                                    apiName: "city",
                                    displayName: "city",
                                    type: { kind: "string", required: true },
                                },
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
                            fields: [{ apiName: "city", displayName: "city", type: { kind: "string" } }],
                        },
                    },
                ],
            };

            const code = generateZod(schema);
            expect(code).toContain("export type Address = z.infer<typeof AddressSchema>");
        });

        it("should generate z.date() for timestamp (conceptual type)", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Event",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "createdAt",
                                    displayName: "createdAt",
                                    type: { kind: "timestamp", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            const code = generateZod(schema);
            expect(code).toContain("createdAt: z.date()");
        });

        it("should generate z.date() for date (conceptual type)", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Event",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "eventDate",
                                    displayName: "eventDate",
                                    type: { kind: "date", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            const code = generateZod(schema);
            expect(code).toContain("eventDate: z.date()");
        });


        it("should generate z.number().int() for integer (conceptual type)", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Item",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "quantity",
                                    displayName: "quantity",
                                    type: { kind: "integer", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            const code = generateZod(schema);
            expect(code).toContain("quantity: z.number().int()");
        });
    });
});
