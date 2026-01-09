/**
 * Example: Order schema with Address value type.
 *
 * Demonstrates:
 * - Struct types (Address, LineItem, Order)
 * - References to named types (using both string refs and builder refs)
 * - Lists of references
 * - Required vs optional fields (optional by default)
 * - String enum constraints for OrderStatus
 */

import { s } from "../idl/index.js";

// Define Address struct
export const Address = s.struct(
    {
        line1: s.string().required(),
        line2: s.string(),
        city: s.string().required(),
        state: s.string().required(),
        zip: s.string().required(),
        country: s.string().required(),
    },
    "A mailing address"
);

// Define LineItem struct
export const LineItem = s.struct(
    {
        productId: s.string().required(),
        productName: s.string().required(),
        quantity: s.integer().required(),
        unitPrice: s.double().required(),
    },
    "A line item in an order"
);

// Define Order struct with references
export const Order = s.struct(
    {
        id: s.string().required(),
        status: s
            .stringEnum([
                { value: "pending", label: "Pending" },
                { value: "processing", label: "Processing" },
                { value: "shipped", label: "Shipped" },
                { value: "delivered", label: "Delivered" },
                { value: "cancelled", label: "Cancelled" },
            ])
            .required(),
        shipTo: s.ref("Address"), // Reference by string name
        billTo: s.ref("Address"),
        items: s.list(s.ref("LineItem")).required(),
        notes: s.string(),
        createdAt: s.timestamp().required(),
        updatedAt: s.timestamp(),
    },
    "A customer order"
);

// Build the schema with named types
export const orderSchema = s
    .schema()
    .add("Address", Address)
    .add("LineItem", LineItem)
    .add("Order", Order)
    .build();
