import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { generateTypes } from "./types.js";
import type { OntologyIR } from "../ir/generated/types.js";

describe("generateTypes", () => {
    it("lowers object references to referenced primary key types", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "User",
                    displayName: "User",
                    pluralDisplayName: "Users",
                    primaryKey: "userId",
                    properties: [
                        { name: "userId", displayName: "User ID", type: o.string({}) },
                        { name: "name", displayName: "Name", type: o.string({}) },
                    ],
                },
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "taskId",
                    properties: [
                        { name: "taskId", displayName: "Task ID", type: o.string({}) },
                        {
                            name: "assigneeId",
                            displayName: "Assignee ID",
                            type: o.objectReference({ objectType: "User" }),
                        },
                    ],
                },
            ],
            linkTypes: [],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("export type Task = {");
        expect(output).toContain("assigneeId: string;");
        expect(output).not.toContain("ObjectReferenceTypeDef");
    });
});
