/**
 * Example: Shape union type.
 *
 * Demonstrates:
 * - Union types with variants
 * - Inline struct types within variants
 * - Required vs optional fields
 */

import { s, SchemaIR } from "../ir/index.js";

export const shapesSchema = {
    types: [
        // Define a Shape union with different variants
        {
            name: "Shape",
            description: "A geometric shape",
            type: s.union({
                variants: [
                    {
                        name: "circle",
                        type: s.struct({
                            fields: [
                                { name: "radius", displayName: "Radius", type: s.double({}) },
                                {
                                    name: "color",
                                    displayName: "Color",
                                    type: s.optional({ type: s.string({}) }),
                                },
                            ],
                        }),
                    },
                    {
                        name: "rectangle",
                        type: s.struct({
                            fields: [
                                { name: "width", displayName: "Width", type: s.double({}) },
                                { name: "height", displayName: "Height", type: s.double({}) },
                                {
                                    name: "color",
                                    displayName: "Color",
                                    type: s.optional({ type: s.string({}) }),
                                },
                            ],
                        }),
                    },
                    {
                        name: "triangle",
                        type: s.struct({
                            fields: [
                                { name: "base", displayName: "Base", type: s.double({}) },
                                { name: "height", displayName: "Height", type: s.double({}) },
                                {
                                    name: "color",
                                    displayName: "Color",
                                    type: s.optional({ type: s.string({}) }),
                                },
                            ],
                        }),
                    },
                ],
            }),
        },

        // Define a Drawing that contains multiple shapes
        {
            name: "Drawing",
            description: "A collection of shapes",
            type: s.struct({
                fields: [
                    { name: "name", displayName: "Name", type: s.string({}) },
                    {
                        name: "shapes",
                        displayName: "Shapes",
                        type: s.list({ elementType: s.ref({ name: "Shape" }) }),
                    },
                    {
                        name: "background",
                        displayName: "Background",
                        type: s.optional({ type: s.string({}) }),
                    },
                ],
            }),
        },
    ],
} satisfies SchemaIR;
