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
              import * as t from "./types.js";

              export const Address: z.ZodMiniType<t.Address> = z.object({ city: z.string(), zip: z.optional(z.string()) });"
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
              import * as t from "./types.js";

              export const Order: z.ZodMiniType<t.Order> = z.object({ status: z.enum(["pending", "active"]) });"
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
              import * as t from "./types.js";

              export const Address: z.ZodMiniType<t.Address> = z.object({ city: z.string() });

              export const Order: z.ZodMiniType<t.Order> = z.object({ shipTo: z.optional(z.lazy(() => Address)) });"
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
              import * as t from "./types.js";

              export const Address: z.ZodMiniType<t.Address> = z.object({ city: z.optional(z.string()) });"
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
              import * as t from "./types.js";

              export const Event: z.ZodMiniType<t.Event> = z.object({ createdAt: z.instanceof(Temporal.Instant) });"
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
              import * as t from "./types.js";

              export const Event: z.ZodMiniType<t.Event> = z.object({ eventDate: z.instanceof(Temporal.PlainDate) });"
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
              import * as t from "./types.js";

              export const Item: z.ZodMiniType<t.Item> = z.object({ quantity: z.int32() });"
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
              import * as t from "./types.js";

              export const Measurement: z.ZodMiniType<t.Measurement> = z.object({ value: z.float32() });"
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
              import * as t from "./types.js";

              export const Coordinate: z.ZodMiniType<t.Coordinate> = z.object({ latitude: z.float64() });"
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
              import * as t from "./types.js";

              export const Location: z.ZodMiniType<t.Location> = z.object({ position: z.object({ lat: z.float64().min(-90).max(90), lon: z.float64().min(-180).max(180) }) });"
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
              import * as t from "./types.js";

              export const Cart: z.ZodMiniType<t.Cart> = z.object({ items: z.array(z.string()) });"
            `);
        });

        it("should generate map schema for map type", () => {
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
              import * as t from "./types.js";

              export const Config: z.ZodMiniType<t.Config> = z.object({ settings: z.record(z.string(), z.string()) });"
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
              import * as t from "./types.js";

              export const Shape: z.ZodMiniType<t.Shape> = z.discriminatedUnion("kind", [z.object({ kind: z.literal("circle"), value: z.object({ radius: z.float64() }) }), z.object({ kind: z.literal("square"), value: z.object({ side: z.float64() }) })]);"
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
              import * as t from "./types.js";

              export const ApiResponse: z.ZodMiniType<t.ApiResponse> = z.discriminatedUnion("kind", [z.object({ kind: z.literal("ok"), value: z.string() }), z.object({ kind: z.literal("err"), value: z.string() })]);"
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
              import * as t from "./types.js";

              export const User: z.ZodMiniType<t.User> = z.object({ name: z.string() });"
            `);
        });
    });
});
