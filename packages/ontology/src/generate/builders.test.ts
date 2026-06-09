import { describe, expect, it } from "vitest";
import { generateBuilders } from "./builders.js";
import type { OntologyIR } from "../ir/index.js";

describe("generateBuilders", () => {
    it("generates union variant builders for type-only schemas", () => {
        const schema: Pick<OntologyIR, "types"> = {
            types: [
                {
                    name: "Shape",
                    type: {
                        kind: "union",
                        value: {
                            variants: [
                                { name: "circle", type: { kind: "ref", value: { name: "CircleDef" } } },
                                { name: "square", type: { kind: "ref", value: { name: "SquareDef" } } },
                            ],
                        },
                    },
                },
            ],
        };

        expect(generateBuilders(schema, { exportName: "o" })).toMatchInlineSnapshot(`
          "import * as t from "./types.js";

          export const Shape = { circle: (value: Extract<t.Shape, { kind: "circle" }>["value"]) => ({ kind: "circle" as const, value }), square: (value: Extract<t.Shape, { kind: "square" }>["value"]) => ({ kind: "square" as const, value }) };

          export const o = { Shape };"
        `);
    });

    it("can promote union variant builders", () => {
        const schema: Pick<OntologyIR, "types"> = {
            types: [
                {
                    name: "Shape",
                    type: {
                        kind: "union",
                        value: {
                            variants: [
                                { name: "circle", type: { kind: "ref", value: { name: "CircleDef" } } },
                                { name: "square", type: { kind: "ref", value: { name: "SquareDef" } } },
                            ],
                        },
                    },
                },
            ],
        };

        expect(generateBuilders(schema, { exportName: "o", promoted: "Shape" })).toContain(
            "export const o = { circle, square };"
        );
    });
});
