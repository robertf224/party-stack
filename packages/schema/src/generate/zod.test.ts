import { describe, expect, it } from "vitest";
import { generateZod } from "./index.js";
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Address = z.optional(z.object({ city: z.string(), zip: z.optional(z.string()) }));

              export type Address = z.infer<typeof Address>;"
            `);
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Order = z.optional(z.object({ status: z.enum(["pending", "active"]) }));

              export type Order = z.infer<typeof Order>;"
            `);
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Address = z.optional(z.object({ city: z.string() }));

              export type Address = z.infer<typeof Address>;

              export const Order = z.optional(z.object({ shipTo: z.optional(Address) }));

              export type Order = z.infer<typeof Order>;"
            `);
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Address = z.optional(z.object({ city: z.optional(z.string()) }));

              export type Address = z.infer<typeof Address>;"
            `);
        });

        it("should generate Temporal.Instant for timestamp", () => {
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Event = z.optional(z.object({ createdAt: z.instanceof(Temporal.Instant) }));

              export type Event = z.infer<typeof Event>;"
            `);
        });

        it("should generate Temporal.PlainDate for date", () => {
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Event = z.optional(z.object({ eventDate: z.instanceof(Temporal.PlainDate) }));

              export type Event = z.infer<typeof Event>;"
            `);
        });

        it("should generate z.int32() for integer", () => {
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

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Item = z.optional(z.object({ quantity: z.int32() }));

              export type Item = z.infer<typeof Item>;"
            `);
        });

        it("should generate z.float32() for float", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Measurement",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "value",
                                    displayName: "value",
                                    type: { kind: "float", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Measurement = z.optional(z.object({ value: z.float32() }));

              export type Measurement = z.infer<typeof Measurement>;"
            `);
        });

        it("should generate z.float64() for double", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Coordinate",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "latitude",
                                    displayName: "latitude",
                                    type: { kind: "double", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Coordinate = z.optional(z.object({ latitude: z.float64() }));

              export type Coordinate = z.infer<typeof Coordinate>;"
            `);
        });

        it("should generate geopoint schema", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Location",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "position",
                                    displayName: "position",
                                    type: { kind: "geopoint", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Location = z.optional(z.object({ position: z.object({ lat: z.float64().min(-90).max(90), lon: z.float64().min(-180).max(180) }) }));

              export type Location = z.infer<typeof Location>;"
            `);
        });

        it("should generate array schema for list type", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Cart",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "items",
                                    displayName: "items",
                                    type: {
                                        kind: "list",
                                        elementType: { kind: "string", required: true },
                                        required: true,
                                    },
                                },
                            ],
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Cart = z.optional(z.object({ items: z.array(z.string()) }));

              export type Cart = z.infer<typeof Cart>;"
            `);
        });

        it("should generate record schema for map type", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "Config",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "settings",
                                    displayName: "settings",
                                    type: {
                                        kind: "map",
                                        keyType: { kind: "string", required: true },
                                        valueType: { kind: "string", required: true },
                                        required: true,
                                    },
                                },
                            ],
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Config = z.optional(z.object({ settings: z.record(z.string(), z.string()) }));

              export type Config = z.infer<typeof Config>;"
            `);
        });

        it("should generate discriminated union for union type", () => {
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
                                            {
                                                apiName: "radius",
                                                displayName: "radius",
                                                type: { kind: "double", required: true },
                                            },
                                        ],
                                        required: true,
                                    },
                                },
                                {
                                    apiName: "square",
                                    type: {
                                        kind: "struct",
                                        fields: [
                                            {
                                                apiName: "side",
                                                displayName: "side",
                                                type: { kind: "double", required: true },
                                            },
                                        ],
                                        required: true,
                                    },
                                },
                            ],
                            required: true,
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Shape = z.discriminatedUnion("kind", [z.object({ kind: z.literal("circle"), value: z.object({ radius: z.float64() }) }), z.object({ kind: z.literal("square"), value: z.object({ side: z.float64() }) })]);

              export type Shape = z.infer<typeof Shape>;"
            `);
        });

        it("should generate result type as discriminated union", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "ApiResponse",
                        type: {
                            kind: "result",
                            okType: { kind: "string", required: true },
                            errType: { kind: "string", required: true },
                            required: true,
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const ApiResponse = z.discriminatedUnion("kind", [z.object({ kind: z.literal("ok"), value: z.string() }), z.object({ kind: z.literal("err"), value: z.string() })]);

              export type ApiResponse = z.infer<typeof ApiResponse>;"
            `);
        });

        it("should include JSDoc comments for types with descriptions", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        apiName: "User",
                        description: "Represents a user in the system",
                        type: {
                            kind: "struct",
                            fields: [
                                {
                                    apiName: "name",
                                    displayName: "name",
                                    type: { kind: "string", required: true },
                                },
                            ],
                        },
                    },
                ],
            };

            expect(generateZod(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              /** Represents a user in the system */
              export const User = z.optional(z.object({ name: z.string() }));

              export type User = z.infer<typeof User>;"
            `);
        });
    });
});
