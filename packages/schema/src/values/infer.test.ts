import { describe, expect, expectTypeOf, it } from "vitest";
import { s } from "../ir/index.js";
import { defineSchema } from "./infer.js";
import type { ConstSchemaIR, Infer } from "./infer.js";
import type { double, integer, Result, timestamp, Union } from "./values.js";

const schema = defineSchema({
    types: [
        {
            name: "Address",
            type: {
                kind: "struct",
                value: {
                    fields: [
                        { name: "city", displayName: "City", type: { kind: "string", value: {} } },
                        {
                            name: "postal-code",
                            displayName: "Postal Code",
                            type: { kind: "optional", value: { type: { kind: "string", value: {} } } },
                        },
                    ],
                },
            },
        },
        {
            name: "OrderStatus",
            type: {
                kind: "string",
                value: {
                    constraint: {
                        kind: "enum",
                        value: {
                            options: [{ value: "pending" }, { value: "shipped" }],
                        },
                    },
                },
            },
        },
        {
            name: "LineItem",
            type: {
                kind: "struct",
                value: {
                    fields: [
                        { name: "sku", displayName: "SKU", type: { kind: "string", value: {} } },
                        { name: "quantity", displayName: "Quantity", type: { kind: "integer", value: {} } },
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
                        { name: "id", displayName: "ID", type: { kind: "string", value: {} } },
                        {
                            name: "status",
                            displayName: "Status",
                            type: { kind: "ref", value: { name: "OrderStatus" } },
                        },
                        {
                            name: "shipTo",
                            displayName: "Ship To",
                            type: {
                                kind: "optional",
                                value: { type: { kind: "ref", value: { name: "Address" } } },
                            },
                        },
                        {
                            name: "items",
                            displayName: "Items",
                            type: {
                                kind: "list",
                                value: { elementType: { kind: "ref", value: { name: "LineItem" } } },
                            },
                        },
                        {
                            name: "metadata",
                            displayName: "Metadata",
                            type: {
                                kind: "map",
                                value: {
                                    keyType: { kind: "string", value: {} },
                                    valueType: { kind: "unknown", value: {} },
                                },
                            },
                        },
                        {
                            name: "createdAt",
                            displayName: "Created At",
                            type: { kind: "timestamp", value: {} },
                        },
                    ],
                },
            },
        },
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
                                            displayName: "Radius",
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
                                            displayName: "Side",
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
        {
            name: "SaveResult",
            type: {
                kind: "result",
                value: {
                    okType: { kind: "ref", value: { name: "Order" } },
                    errType: { kind: "string", value: {} },
                },
            },
        },
    ],
});

const builderSchema = defineSchema({
    types: [
        {
            name: "OrderStatus",
            type: s.string({
                constraint: s.StringConstraint.enum({
                    options: [{ value: "pending" }, { value: "shipped" }],
                }),
            }),
        },
        {
            name: "Order",
            type: s.struct({
                fields: [
                    { name: "id", displayName: "ID", type: s.string({}) },
                    {
                        name: "status",
                        displayName: "Status",
                        type: s.ref({ name: "OrderStatus" }),
                    },
                ],
            }),
        },
    ],
});

describe("SchemaIR type inference", () => {
    it("infers named schema types from a const SchemaIR", () => {
        type Types = Infer<typeof schema>;
        type Order = Types["Order"];

        expect(schema.types).toHaveLength(6);
        expectTypeOf<typeof schema>().toMatchTypeOf<ConstSchemaIR>();
        expectTypeOf<Types["OrderStatus"]>().toEqualTypeOf<"pending" | "shipped">();
        expectTypeOf<Order["id"]>().toEqualTypeOf<string>();
        expectTypeOf<Order["status"]>().toEqualTypeOf<"pending" | "shipped">();
        expectTypeOf<Order["shipTo"]>().toEqualTypeOf<
            | {
                  city: string;
                  "postal-code"?: string | undefined;
              }
            | undefined
        >();
        expectTypeOf<Order["items"]>().toEqualTypeOf<Array<{ sku: string; quantity: integer }>>();
        expectTypeOf<Order["metadata"]>().toEqualTypeOf<Record<string, unknown>>();
        expectTypeOf<Order["createdAt"]>().toEqualTypeOf<timestamp>();
    });

    it("infers unions and results", () => {
        expectTypeOf<Infer<typeof schema>["Shape"]>().toEqualTypeOf<
            Union<{
                circle: { radius: double };
                square: { side: double };
            }>
        >();

        expectTypeOf<Infer<typeof schema>["SaveResult"]>().toEqualTypeOf<
            Result<Infer<typeof schema>["Order"], string>
        >();
    });

    it("infers optional wrappers outside of struct fields", () => {
        type OptionalBoolean = Infer<{
            kind: "optional";
            value: { type: { kind: "boolean"; value: Record<never, never> } };
        }>;

        expectTypeOf<OptionalBoolean>().toEqualTypeOf<boolean | undefined>();
    });

    it("preserves literals from the builder API", () => {
        expect(builderSchema.types).toHaveLength(2);
        expectTypeOf<Infer<typeof builderSchema>["OrderStatus"]>().toEqualTypeOf<"pending" | "shipped">();
        expectTypeOf<Infer<typeof builderSchema>["Order"]>().toEqualTypeOf<{
            id: string;
            status: "pending" | "shipped";
        }>();
    });
});
