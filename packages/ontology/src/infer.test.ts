import { describe, expect, expectTypeOf, it } from "vitest";
import { defineNamedType, defineOntology, defineType, type Infer } from "./infer.js";
import { o } from "./ir/generated/builders.js";
import type { attachment, timestamp } from "./utils/values.js";

describe("Infer", () => {
    const addressType = defineNamedType({
        name: "Address",
        type: o.struct({
            fields: [
                { name: "city", displayName: "City", type: o.string({}) },
                {
                    name: "line2",
                    displayName: "Line 2",
                    type: o.optional({ type: o.string({}) }),
                },
            ],
        }),
    });

    const ontology = defineOntology({
        types: [addressType],
        objectTypes: [
            {
                name: "User",
                displayName: "User",
                pluralDisplayName: "Users",
                primaryKey: "userId",
                properties: [
                    { name: "userId", displayName: "User ID", type: o.string({}) },
                    {
                        name: "status",
                        displayName: "Status",
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [{ value: "active" }, { value: "disabled" }],
                            }),
                        }),
                    },
                    { name: "avatar", displayName: "Avatar", type: o.optional({ type: o.attachment({}) }) },
                    { name: "address", displayName: "Address", type: o.ref({ name: "Address" }) },
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
                        name: "ownerId",
                        displayName: "Owner ID",
                        type: o.objectReference({ objectType: "User" }),
                    },
                ],
            },
        ],
        linkTypes: [],
        actionTypes: [
            {
                name: "createTask",
                displayName: "Create Task",
                parameters: [
                    {
                        name: "owner",
                        displayName: "Owner",
                        type: o.objectReference({ objectType: "User" }),
                    },
                    { name: "title", displayName: "Title", type: o.string({}) },
                    {
                        name: "notes",
                        displayName: "Notes",
                        type: o.optional({ type: o.string({}) }),
                    },
                    {
                        name: "createdAt",
                        displayName: "Created At",
                        type: o.timestamp({}),
                        defaultValue: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                    },
                ],
                logic: [],
            },
        ],
        queryTypes: [
            {
                name: "searchTasks",
                displayName: "Search Tasks",
                parameters: [
                    { name: "query", displayName: "Query", type: o.string({}) },
                    {
                        name: "limit",
                        displayName: "Limit",
                        type: o.optional({ type: o.integer({}) }),
                    },
                ],
                returnType: o.list({ elementType: o.objectReference({ objectType: "Task" }) }),
            },
        ],
    });

    it("infers an OntologyDefinition from an ontology IR value", () => {
        expect(ontology).toBeDefined();

        type InferredOntology = Infer<typeof ontology>;

        expectTypeOf<InferredOntology["objectTypes"]["User"]>().toEqualTypeOf<{
            userId: string;
            status: "active" | "disabled";
            avatar?: attachment;
            address: {
                city: string;
                line2?: string;
            };
        }>();
        expectTypeOf<InferredOntology["objectTypes"]["Task"]>().toEqualTypeOf<{
            taskId: string;
            ownerId: string;
        }>();
        expectTypeOf<InferredOntology["actionTypes"]["createTask"]["parameters"]>().toEqualTypeOf<{
            owner: string;
            title: string;
            notes?: string | null;
            createdAt?: timestamp;
        }>();
        expectTypeOf<InferredOntology["queryTypes"]["searchTasks"]["parameters"]>().toEqualTypeOf<{
            query: string;
            limit?: number;
        }>();
        expectTypeOf<InferredOntology["queryTypes"]["searchTasks"]["returnType"]>().toEqualTypeOf<
            string[]
        >();
    });

    it("infers individual named type definitions against an ontology", () => {
        expectTypeOf<Infer<typeof addressType, typeof ontology>>().toEqualTypeOf<{
            city: string;
            line2?: string;
        }>();
    });

    it("infers individual type definitions against an ontology", () => {
        const userReference = defineType(o.objectReference({ objectType: "User" }));

        expect(userReference).toBeDefined();
        expectTypeOf<Infer<typeof userReference, typeof ontology>>().toEqualTypeOf<string>();
    });
});
