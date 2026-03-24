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
            actionTypes: [],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("export type Task = {");
        expect(output).toContain("assigneeId: string;");
        expect(output).not.toContain("ObjectReferenceTypeDef");
    });

    it("generates action parameter types through schema lowering", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Author",
                    displayName: "Author",
                    pluralDisplayName: "Authors",
                    primaryKey: "authorId",
                    properties: [
                        { name: "authorId", displayName: "Author ID", type: o.string({}) },
                        { name: "name", displayName: "Name", type: o.string({}) },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createPost",
                    displayName: "Create Post",
                    parameters: [
                        {
                            name: "author",
                            displayName: "Author",
                            type: o.objectReference({ objectType: "Author" }),
                        },
                        {
                            name: "status",
                            displayName: "Status",
                            type: o.string({
                                constraint: o.StringConstraint.enum({
                                    options: [
                                        { value: "draft" },
                                        { value: "published" },
                                    ],
                                }),
                            }),
                        },
                        {
                            name: "postId",
                            displayName: "Post ID",
                            type: o.string({}),
                            defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                        },
                    ],
                    logic: [],
                },
            ],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("export type CreatePostParameters = {");
        expect(output).toContain("author: string;");
        expect(output).toContain('status: "draft" | "published";');
        expect(output).toContain("postId?: string;");
        expect(output).toContain("actionTypes: {");
        expect(output).toContain("createPost: {");
        expect(output).toContain("parameters: CreatePostParameters;");
        expect(output).toContain("};\n\nexport type TestOntology = {");
    });

    it("quotes invalid action parameter and action names", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [
                {
                    name: "create-task",
                    displayName: "Create Task",
                    parameters: [
                        {
                            name: "__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef",
                            displayName: "Generated UUID 1",
                            type: o.string({}),
                            defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                        },
                    ],
                    logic: [],
                },
            ],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain('"__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef"?: string;');
        expect(output).toContain('"create-task": {');
    });
});
