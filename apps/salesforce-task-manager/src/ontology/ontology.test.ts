import { describe, expect, it } from "vitest";
import ontology from "./ontology.js";

describe("generated Salesforce task-manager ontology", () => {
    it("contains Task and User with scoped references", () => {
        expect(
            ontology.objectTypes.map(
                (objectType) => objectType.name
            )
        ).toEqual(["Task", "User"]);

        const task = ontology.objectTypes.find(
            (objectType) =>
                objectType.name === "Task"
        )!;
        expect(task.primaryKey).toBe("Id");
        expect(task.title).toBe("Subject");
        expect(
            task.properties.find(
                (property) =>
                    property.name === "CreatedById"
            )?.type
        ).toEqual({
            kind: "objectReference",
            value: {
                objectType: "User",
            },
        });
        expect(
            task.properties.find(
                (property) =>
                    String(property.name) ===
                    "AccountId"
            )
        ).toBeUndefined();
        expect(
            ontology.actionTypes.map(
                (action) => action.name
            )
        ).toEqual([
            "createTask",
            "updateTask",
            "deleteTask",
        ]);
    });
});
