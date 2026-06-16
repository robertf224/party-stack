import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { generateTypeDefinitions, generateTypes } from "./types.js";
import type { OntologyIR } from "../ir/generated/types.js";

describe("generateTypes", () => {
    it("generates type-only struct definitions with ontology values imports", () => {
        const ontology: Pick<OntologyIR, "types"> = {
            types: [
                {
                    name: "Address",
                    type: {
                        kind: "struct",
                        value: {
                            fields: [
                                { name: "city", displayName: "City", type: o.string({}) },
                                {
                                    name: "zip",
                                    displayName: "ZIP",
                                    type: o.optional({ type: o.string({}) }),
                                },
                            ],
                        },
                    },
                },
            ],
        };

        expect(generateTypeDefinitions(ontology)).toMatchInlineSnapshot(`
          "import * as v from "@party-stack/ontology/values";

          export type Address = {
                  city: string;
                  zip?: string;
              };"
        `);
    });

    it("renders ontology value primitives", () => {
        const ontology: Pick<OntologyIR, "types"> = {
            types: [
                { name: "CreatedAt", type: o.timestamp({}) },
                { name: "File", type: o.attachment({}) },
            ],
        };

        expect(generateTypeDefinitions(ontology)).toContain("export type CreatedAt = v.timestamp;");
        expect(generateTypeDefinitions(ontology)).toContain("export type File = v.attachment;");
    });

    it("requires object type context to generate object references", () => {
        const ontology: Pick<OntologyIR, "types"> = {
            types: [{ name: "UserRef", type: o.objectReference({ objectType: "User" }) }],
        };

        expect(() => generateTypeDefinitions(ontology)).toThrow(
            'Cannot generate object reference type for unknown object type "User".'
        );
    });

    it("generates object references as referenced primary key types", () => {
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
            queryTypes: [],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("export type Task = {");
        expect(output).toContain("assigneeId: string;");
        expect(output).not.toContain("ObjectReferenceTypeDef");
    });

    it("generates action parameter types", () => {
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
                                    options: [{ value: "draft" }, { value: "published" }],
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
            queryTypes: [],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("export type CreatePostParameters = {");
        expect(output).toContain("author: string;");
        expect(output).toContain('status: "draft" | "published";');
        expect(output).toContain("postId?: string;");
        expect(output).toContain("actionTypes: {");
        expect(output).toContain("createPost: {");
        expect(output).toContain("parameters: CreatePostParameters;");
        expect(output).toContain("export type TestOntology = {");
    });

    it("allows null for optional action parameters without adding null to defaulted required parameters", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [
                {
                    name: "reopenTask",
                    displayName: "Reopen Task",
                    parameters: [
                        {
                            name: "completedAt",
                            displayName: "Completed At",
                            type: o.optional({ type: o.timestamp({}) }),
                        },
                        {
                            name: "taskId",
                            displayName: "Task ID",
                            type: o.string({}),
                            defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                        },
                    ],
                    logic: [],
                },
            ],
            queryTypes: [],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("completedAt?: v.timestamp | null;");
        expect(output).toContain("taskId?: string;");
        expect(output).not.toContain("taskId?: string | null;");
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
            queryTypes: [],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain('"__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef"?: string;');
        expect(output).toContain('"create-task": {');
    });

    it("generates query type parameter and return types", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
            queryTypes: [
                {
                    name: "searchPosts",
                    displayName: "Search Posts",
                    parameters: [
                        { name: "query", displayName: "Query", type: o.string({}) },
                        {
                            name: "limit",
                            displayName: "Limit",
                            type: o.optional({ type: o.integer({}) }),
                        },
                    ],
                    returnType: o.list({ elementType: o.string({}) }),
                },
            ],
        };

        const output = generateTypes(ontology, { outputTypeName: "TestOntology" });

        expect(output).toContain("export type SearchPostsParameters = {");
        expect(output).toContain("query: string;");
        expect(output).toContain("limit?: v.integer | undefined;");
        expect(output).toContain("export type SearchPostsReturn = Array<string>;");
        expect(output).toContain("queryTypes: {");
        expect(output).toContain("searchPosts: {");
        expect(output).toContain("parameters: SearchPostsParameters;");
        expect(output).toContain("returnType: SearchPostsReturn;");
    });
});
