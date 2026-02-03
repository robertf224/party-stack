import { describe, expect, it } from "vitest";
import { generateTypes } from "./index.js";
import type { SchemaIR } from "../ir/index.js";

describe("TypeScript Type Generation", () => {
    describe("Struct Types", () => {
        it("should generate interface for simple struct", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Address {
                  city: string;
                  zip?: string;
              }"
            `);
        });

        it("should generate interface for empty struct", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "EmptyType",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [],
                            },
                        },
                    },
                ],
            };

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface EmptyType {
              }"
            `);
        });

        it("should include JSDoc for types with descriptions", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "/** Represents a user in the system */
              export interface User {
                  name: string;
              }"
            `);
        });

        it("should include JSDoc for fields with descriptions", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "User",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "email",
                                        displayName: "Email",
                                        type: { kind: "string", value: {} },
                                        description: "The user's email address",
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface User {
                  /** The user's email address */
                  email: string;
              }"
            `);
        });

        it("should include @deprecated tag for deprecated types", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "LegacyUser",
                        deprecated: { message: "Use User instead" },
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

            const result = generateTypes(schema);
            expect(result).toContain("@deprecated Use User instead");
        });

        it("should include @deprecated tag for deprecated fields", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "User",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "oldEmail",
                                        displayName: "Old Email",
                                        type: { kind: "string", value: {} },
                                        deprecated: { message: "Use email instead" },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            const result = generateTypes(schema);
            expect(result).toContain("@deprecated Use email instead");
        });

        it("should include both description and @deprecated tag", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "OldUser",
                        description: "Represents a user in the old system",
                        deprecated: { message: "Use NewUser instead" },
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

            const result = generateTypes(schema);
            expect(result).toContain("Represents a user in the old system");
            expect(result).toContain("@deprecated Use NewUser instead");
        });
    });

    describe("Primitive Types", () => {
        it("should generate string type", () => {
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
                ],
            };

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Item {
                  name: string;
              }"
            `);
        });

        it("should generate boolean type", () => {
            const schema: SchemaIR = {
                types: [
                    {
                        name: "Item",
                        type: {
                            kind: "struct",
                            value: {
                                fields: [
                                    {
                                        name: "active",
                                        displayName: "active",
                                        type: { kind: "boolean", value: {} },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Item {
                  active: boolean;
              }"
            `);
        });

        it("should generate number for integer", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Item {
                  quantity: number;
              }"
            `);
        });

        it("should generate number for float", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Measurement {
                  value: number;
              }"
            `);
        });

        it("should generate number for double", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Coordinate {
                  latitude: number;
              }"
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Event {
                  eventDate: Temporal.PlainDate;
              }"
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Event {
                  createdAt: Temporal.Instant;
              }"
            `);
        });

        it("should generate geopoint type", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Location {
                  position: {
                          lat: number;
                          lon: number;
                      };
              }"
            `);
        });
    });

    describe("String Enums", () => {
        it("should generate string literal union for string enums", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Order {
                  status: "pending" | "active";
              }"
            `);
        });
    });

    describe("Collection Types", () => {
        it("should generate array type for list", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Cart {
                  items: Array<string>;
              }"
            `);
        });

        it("should generate Array<T> for complex element types", () => {
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
                                                elementType: {
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
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Cart {
                  items: Array<{
                          name: string;
                      }>;
              }"
            `);
        });

        it("should generate Map type for map", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "import * as v from "@party-stack/schema/values";

              export type Config = {
                      settings: Map<string, string>;
                  };"
            `);
        });
    });

    describe("Union Types", () => {
        it("should generate discriminated union type", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export type Shape = {
                      kind: "circle";
                      value: {
                              radius: number;
                          };
                  } | {
                      kind: "square";
                      value: {
                              side: number;
                          };
                  };"
            `);
        });
    });

    describe("Result Types", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export type ApiResponse = {
                      kind: "ok";
                      value: string;
                  } | {
                      kind: "err";
                      value: string;
                  };"
            `);
        });
    });

    describe("Type References", () => {
        it("should generate refs as type references", () => {
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

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Address {
                  city: string;
              }

              export interface Order {
                  shipTo?: Address;
              }"
            `);
        });

        it("should generate list of refs", () => {
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
                                            value: { elementType: { kind: "ref", value: { name: "Item" } } },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            };

            expect(generateTypes(schema)).toMatchInlineSnapshot(`
              "export interface Item {
                  name: string;
              }

              export interface Cart {
                  items: Array<Item>;
              }"
            `);
        });
    });
});
