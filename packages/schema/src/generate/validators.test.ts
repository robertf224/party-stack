import { describe, expect, it } from "vitest";
import { generateValidators } from "./index.js";
import type { SchemaIR } from "../ir/index.js";

describe("Zod Schema Generation", () => {
    describe("Conceptual Types", () => {
        it("should generate zod schema for simple struct", () => {
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
                                    {
                                        name: "zip",
                                        displayName: "zip",
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

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Address = z.object({ get city() { return z.string(); }, get zip() { return z.optional(z.string()); } });

              export type Address = z.infer<typeof Address>;"
            `);
        });

        it("should generate zod enum for string enums", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Order",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "status",
                                        displayName: "status",
                                        type: {
                                            kind: "string",
                                            value: {
                                                constraint: {
                                                    kind: "enum",
                                                    value: {
                                                        options: [{ value: "pending" }, { value: "active" }],
                                                    },
                                                },
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Order = z.object({ get status() { return z.enum(["pending", "active"]); } });

              export type Order = z.infer<typeof Order>;"
            `);
        });

        it("should generate refs as schema references", () => {
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
                                        type: {
                                            kind: "optional",
                                            value: { type: { kind: "ref", value: { name: "Address" } } },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Address = z.object({ get city() { return z.string(); } });

              export type Address = z.infer<typeof Address>;

              export const Order = z.object({ get shipTo() { return z.optional(Address); } });

              export type Order = z.infer<typeof Order>;"
            `);
        });

        it("should generate optional types with wrapper", () => {
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

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Address = z.object({ get city() { return z.optional(z.string()); } });

              export type Address = z.infer<typeof Address>;"
            `);
        });

        it("should generate Temporal.Instant for timestamp", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Event",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "createdAt",
                                        displayName: "createdAt",
                                        type: { kind: "timestamp", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Event = z.object({ get createdAt() { return z.instanceof(Temporal.Instant); } });

              export type Event = z.infer<typeof Event>;"
            `);
        });

        it("should generate Temporal.PlainDate for date", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Event",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "eventDate",
                                        displayName: "eventDate",
                                        type: { kind: "date", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Event = z.object({ get eventDate() { return z.instanceof(Temporal.PlainDate); } });

              export type Event = z.infer<typeof Event>;"
            `);
        });

        it("should generate z.int32() for integer", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Item",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "quantity",
                                        displayName: "quantity",
                                        type: { kind: "integer", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Item = z.object({ get quantity() { return z.int32(); } });

              export type Item = z.infer<typeof Item>;"
            `);
        });

        it("should generate z.float32() for float", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Measurement",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "value",
                                        displayName: "value",
                                        type: { kind: "float", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Measurement = z.object({ get value() { return z.float32(); } });

              export type Measurement = z.infer<typeof Measurement>;"
            `);
        });

        it("should generate z.float64() for double", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Coordinate",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "latitude",
                                        displayName: "latitude",
                                        type: { kind: "double", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Coordinate = z.object({ get latitude() { return z.float64(); } });

              export type Coordinate = z.infer<typeof Coordinate>;"
            `);
        });

        it("should generate geopoint schema", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Location",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "position",
                                        displayName: "position",
                                        type: { kind: "geopoint", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Location = z.object({ get position() { return z.object({ lat: z.float64().min(-90).max(90), lon: z.float64().min(-180).max(180) }); } });

              export type Location = z.infer<typeof Location>;"
            `);
        });

        it("should generate array schema for list type", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Cart",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "items",
                                        displayName: "items",
                                        type: {
                                            kind: "list",
                                            value: {
                                                elementType: { kind: "string", value: {} },
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Cart = z.object({ get items() { return z.array(z.string()); } });

              export type Cart = z.infer<typeof Cart>;"
            `);
        });

        it("should generate record schema for map type", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Config",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "settings",
                                        displayName: "settings",
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

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Config = z.object({ get settings() { return z.record(z.string(), z.string()); } });

              export type Config = z.infer<typeof Config>;"
            `);
        });

        it("should generate discriminated union for union type", () => {
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
                                        name: "square",
                                        type: {
                                            kind: "struct",
                                            value: {
                                                fields: [
                                                    {
                                                        name: "side",
                                                        displayName: "side",
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

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const Shape = z.discriminatedUnion("kind", [z.object({ kind: z.literal("circle"), value: z.object({ get radius() { return z.float64(); } }) }), z.object({ kind: z.literal("square"), value: z.object({ get side() { return z.float64(); } }) })]);

              export type Shape = z.infer<typeof Shape>;"
            `);
        });

        it("should generate result type as discriminated union", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "ApiResponse",
                        type: {
                            kind: "result",
                            value: {
                                okType: { kind: "string", value: {} },
                                errType: { kind: "string", value: {} },
                            },
                        },
                    },
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              export const ApiResponse = z.discriminatedUnion("kind", [z.object({ kind: z.literal("ok"), value: z.string() }), z.object({ kind: z.literal("err"), value: z.string() })]);

              export type ApiResponse = z.infer<typeof ApiResponse>;"
            `);
        });

        it("should include JSDoc comments for types with descriptions", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "User",
                        description: "Represents a user in the system",
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
                ],
            };

            expect(generateValidators(schema)).toMatchInlineSnapshot(`
              "import { z } from "zod/mini";

              /** Represents a user in the system */
              export const User = z.object({ get name() { return z.string(); } });

              export type User = z.infer<typeof User>;"
            `);
        });
    });
});
