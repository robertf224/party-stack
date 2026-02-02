/**
 * Example: Order schema with Address value type.
 *
 * Demonstrates:
 * - Struct types (Address, LineItem, Order)
 * - References to named types
 * - Lists of references
 * - Required vs optional fields
 * - String enum constraints for OrderStatus
 */

import { s } from "../ir/builders.js";
import type { SchemaIR } from "../ir/types.js";

export const orderSchema = {
    types: [
        // Define Address struct
        {
            name: "Address",
            description: "A mailing address",
            type: s.struct({
                fields: [
                    { name: "line1", displayName: "Line 1", type: s.string({}) },
                    {
                        name: "line2",
                        displayName: "Line 2",
                        type: s.optional({ type: s.string({}) }),
                    },
                    { name: "city", displayName: "City", type: s.string({}) },
                    { name: "state", displayName: "State", type: s.string({}) },
                    { name: "zip", displayName: "ZIP", type: s.string({}) },
                    { name: "country", displayName: "Country", type: s.string({}) },
                ],
            }),
        },

        // Define LineItem struct
        {
            name: "LineItem",
            description: "A line item in an order",
            type: s.struct({
                fields: [
                    { name: "productId", displayName: "Product ID", type: s.string({}) },
                    { name: "productName", displayName: "Product Name", type: s.string({}) },
                    { name: "quantity", displayName: "Quantity", type: s.integer({}) },
                    { name: "unitPrice", displayName: "Unit Price", type: s.double({}) },
                ],
            }),
        },

        // Define OrderStatus enum
        {
            name: "OrderStatus",
            description: "The status of an order",
            type: s.string({
                constraint: s.StringConstraint.enum({
                    options: [
                        { value: "pending", label: "Pending" },
                        { value: "processing", label: "Processing" },
                        { value: "shipped", label: "Shipped" },
                        { value: "delivered", label: "Delivered" },
                        { value: "cancelled", label: "Cancelled" },
                    ],
                }),
            }),
        },

        // Define Order struct with references
        {
            name: "Order",
            description: "A customer order",
            type: s.struct({
                fields: [
                    { name: "id", displayName: "ID", type: s.string({}) },
                    { name: "status", displayName: "Status", type: s.ref({ name: "OrderStatus" }) },
                    {
                        name: "shipTo",
                        displayName: "Ship To",
                        type: s.optional({ type: s.ref({ name: "Address" }) }),
                    },
                    {
                        name: "billTo",
                        displayName: "Bill To",
                        type: s.optional({ type: s.ref({ name: "Address" }) }),
                    },
                    {
                        name: "items",
                        displayName: "Items",
                        type: s.list({ elementType: s.ref({ name: "LineItem" }) }),
                    },
                    {
                        name: "notes",
                        displayName: "Notes",
                        type: s.optional({ type: s.string({}) }),
                    },
                    { name: "createdAt", displayName: "Created At", type: s.timestamp({}) },
                    {
                        name: "updatedAt",
                        displayName: "Updated At",
                        type: s.optional({ type: s.timestamp({}) }),
                    },
                ],
            }),
        },
    ],
} satisfies SchemaIR;
