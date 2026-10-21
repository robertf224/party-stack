import { describe, expect, it } from "vitest";
import { o } from "./generated/builders.js";
import { validate } from "./validate.js";
import type { Expression, OntologyIR, TypeDef } from "./generated/types.js";

const person = o.Expression.objectLookup({
    reference: o.Expression.inputReference({ name: "person" }),
});
const related = (link: string, source: Expression = person) => o.Expression.related({ source, link });
const name = (source: Expression) => o.Expression.getAt({ source, path: ["name"] });
const names = (source: Expression) =>
    o.Expression.map({
        source,
        binding: "person",
        body: name(o.Expression.localReference({ name: "person" })),
    });

function model(defaultValue: Expression, type: TypeDef): OntologyIR {
    return {
        types: [],
        queryFunctionTypes: [],
        objectTypes: [
            {
                name: "Person",
                displayName: "Person",
                pluralDisplayName: "People",
                primaryKey: "id",
                properties: [
                    { name: "id", displayName: "ID", type: o.string({}) },
                    { name: "name", displayName: "Name", type: o.string({}) },
                    { name: "managerId", displayName: "Manager", type: o.string({}) },
                ],
            },
        ],
        linkTypes: [
            {
                id: "personManager",
                source: { objectType: "Person", name: "reports", displayName: "Reports" },
                target: { objectType: "Person", name: "manager", displayName: "Manager" },
                foreignKey: "managerId",
                cardinality: "many",
            },
        ],
        actionTypes: [
            {
                name: "inspect",
                displayName: "Inspect",
                logic: [],
                parameters: [
                    {
                        name: "person",
                        displayName: "Person",
                        type: o.objectReference({ objectType: "Person" }),
                    },
                    { name: "result", displayName: "Result", type, defaultValue },
                ],
            },
        ],
    };
}

describe("related expression typing", () => {
    it("infers a to-one target in the foreign-key direction", () => {
        expect(validate(model(name(related("manager")), o.string({}))).kind).toBe("ok");
    });

    it("infers a list and its object bindings in the to-many direction", () => {
        expect(validate(model(names(related("reports")), o.list({ elementType: o.string({}) }))).kind).toBe(
            "ok"
        );
    });

    it("keeps related objects typed through nested maps and traversals", () => {
        const mapped = o.Expression.map({
            source: related("reports"),
            binding: "report",
            body: names(related("reports", o.Expression.localReference({ name: "report" }))),
        });
        expect(
            validate(model(mapped, o.list({ elementType: o.list({ elementType: o.string({}) }) }))).kind
        ).toBe("ok");
        expect(validate(model(mapped, o.list({ elementType: o.string({}) }))).kind).toBe("err");
    });

    it("preserves object identity when a map returns its related object", () => {
        const identity = o.Expression.map({
            source: related("reports"),
            binding: "report",
            body: o.Expression.localReference({ name: "report" }),
        });
        expect(validate(model(names(identity), o.list({ elementType: o.string({}) }))).kind).toBe("ok");
    });

    it("rejects collection traversal used as a scalar field or scalar default", () => {
        expect(validate(model(name(related("reports")), o.string({}))).kind).toBe("err");
        expect(validate(model(names(related("reports")), o.string({}))).kind).toBe("err");
        expect(validate(model(names(related("manager")), o.list({ elementType: o.string({}) }))).kind).toBe(
            "err"
        );
    });

    it("validates target fields and link names in either direction", () => {
        expect(validate(model(names(related("missing")), o.list({ elementType: o.string({}) }))).kind).toBe(
            "err"
        );
        const badField = o.Expression.map({
            source: related("reports"),
            binding: "report",
            body: o.Expression.getAt({
                source: o.Expression.localReference({ name: "report" }),
                path: ["missing"],
            }),
        });
        expect(validate(model(badField, o.list({ elementType: o.string({}) }))).kind).toBe("err");
    });

    it("reports missing target definitions without throwing during list inference", () => {
        const identity = o.Expression.map({
            source: related("reports"),
            binding: "report",
            body: o.Expression.localReference({ name: "report" }),
        });
        const ir = model(identity, o.list({ elementType: o.unknown({}) }));
        ir.objectTypes = [];
        expect(validate(ir).kind).toBe("err");
    });
});
