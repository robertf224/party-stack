/**
 * Example: Shape union type.
 *
 * Demonstrates:
 * - Union types with variants
 * - Inline struct types within variants
 * - Required vs optional fields
 */

import { s } from "../idl/index.js";

// Define a Shape union with different variants
export const Shape = s.union(
    "kind", // the discriminant field
    {
        circle: s.struct({
            radius: s.double().required(),
            color: s.string(),
        }),
        rectangle: s.struct({
            width: s.double().required(),
            height: s.double().required(),
            color: s.string(),
        }),
        triangle: s.struct({
            base: s.double().required(),
            height: s.double().required(),
            color: s.string(),
        }),
    },
    "A geometric shape"
);

// Define a Drawing that contains multiple shapes
export const Drawing = s.struct({
    name: s.string().required(),
    shapes: s.list(s.ref("Shape")).required(),
    background: s.string(),
});

// Build the schema with named types
export const shapesSchema = s.schema().add("Shape", Shape).add("Drawing", Drawing).build();
