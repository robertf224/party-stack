import { describe, expect, it } from "vitest";
import { o } from "./generated/builders.js";
import { linkTypeId, withDefinitionIds, withoutDefaultIds } from "./ids.js";
import type { OntologyIR } from "./generated/types.js";

const definition: OntologyIR = {
    types: [{ name: "Status", type: o.string({}) }],
    objectTypes: [
        {
            id: "provider-task",
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "ownerId", displayName: "Owner", type: o.string({}) },
            ],
        },
    ],
    linkTypes: [
        {
            source: { objectType: "Task", name: "tasks", displayName: "Tasks" },
            target: { objectType: "Task", name: "owner", displayName: "Owner" },
            foreignKey: "ownerId",
            cardinality: "many",
        },
    ],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("definition ids", () => {
    it("default to names, and for a link to its source type and traversal name", () => {
        const identified = withDefinitionIds(definition);
        expect(identified.objectTypes[0]?.id).toBe("provider-task");
        expect(identified.objectTypes[0]?.properties.map((property) => property.id)).toEqual([
            "id",
            "ownerId",
        ]);
        expect(identified.types[0]?.id).toBe("Status");
        expect(identified.linkTypes[0]?.id).toBe("Task.owner");
        expect(linkTypeId(definition.linkTypes[0]!)).toBe("Task.owner");
    });

    it("round-trip: dropping defaults restores the definition and keeps provider ids", () => {
        expect(withoutDefaultIds(withDefinitionIds(definition))).toEqual(definition);
    });
});
