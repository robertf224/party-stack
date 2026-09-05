import { describe, expect, it } from "vitest";
import { o } from "./generated/builders.js";
import { validate, ValidationResult } from "./validate.js";
import type { OntologyIR } from "./generated/types.js";

function expectOk(result: ValidationResult): void {
    expect(result.kind).toBe("ok");
}

function expectErr(result: ValidationResult, count?: number): void {
    expect(result.kind).toBe("err");
    if (result.kind === "err" && count !== undefined) {
        expect(result.value).toHaveLength(count);
    }
}

function getErrors(result: ValidationResult): string[] {
    return result.kind === "ok" ? [] : result.value.map((issue) => issue.message);
}

const emptyOntology: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

const minimalObjectType = (overrides?: Partial<OntologyIR["objectTypes"][number]>) => ({
    name: "Employee",
    displayName: "Employee",
    pluralDisplayName: "Employees",
    primaryKey: "employeeId",
    properties: [
        { name: "employeeId", displayName: "Employee ID", type: o.string({}) },
        { name: "name", displayName: "Name", type: o.string({}) },
    ],
    ...overrides,
});

describe("Ontology Validation", () => {
    it("should validate an empty ontology", () => {
        expectOk(validate(emptyOntology));
    });

    it("should validate a simple ontology with object types", () => {
        const ontology: OntologyIR = {
            ...emptyOntology,
            objectTypes: [minimalObjectType()],
        };
        expectOk(validate(ontology));
    });

    describe("Primary Key Validation", () => {
        it("should detect primary key that doesn't reference a property", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ primaryKey: "nonExistent" })],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain(
                'Primary key "nonExistent" does not reference a valid property.'
            );
        });

        it("should accept valid primary key reference", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ primaryKey: "employeeId" })],
            };
            expectOk(validate(ontology));
        });
    });

    describe("Title Validation", () => {
        it("should detect a title that doesn't reference a property", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ title: "nonExistent" })],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Title "nonExistent" does not reference a valid property.');
        });

        it("should accept a valid title property reference", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ title: "name" })],
            };
            expectOk(validate(ontology));
        });
    });

    describe("Duplicate Name Detection", () => {
        it("should detect duplicate object type names", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType(), minimalObjectType()],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate object type name: "Employee".');
        });

        it("should detect duplicate value type names", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                types: [
                    { name: "Address", type: o.struct({ fields: [] }) },
                    { name: "Address", type: o.struct({ fields: [] }) },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate value type name: "Address".');
        });

        it("should detect duplicate link type target names for one source object", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ name: "A" }), minimalObjectType({ name: "B" })],
                linkTypes: [
                    {
                        id: "aToB1",
                        source: { objectType: "A", name: "toB", displayName: "To B" },
                        target: { objectType: "B", name: "fromA", displayName: "From A" },
                        foreignKey: "employeeId",
                        cardinality: "many" as const,
                    },
                    {
                        id: "aToB2",
                        source: { objectType: "A", name: "toB2", displayName: "To B Again" },
                        target: { objectType: "B", name: "fromA", displayName: "From A Again" },
                        foreignKey: "employeeId",
                        cardinality: "one" as const,
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate link type target name: "fromA" on "A".');
        });

        it("should detect duplicate property names within an object type", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Employee",
                        displayName: "Employee",
                        pluralDisplayName: "Employees",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            { name: "id", displayName: "ID Duplicate", type: o.string({}) },
                        ],
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate property name: "id".');
        });

        it("should detect duplicate query function type names and parameters", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                queryFunctionTypes: [
                    {
                        name: "search",
                        displayName: "Search",
                        parameters: [
                            { name: "query", displayName: "Query", type: o.string({}) },
                            { name: "query", displayName: "Query duplicate", type: o.string({}) },
                        ],
                        returnType: o.list({ elementType: o.string({}) }),
                    },
                    {
                        name: "search",
                        displayName: "Search duplicate",
                        parameters: [],
                        returnType: o.string({}),
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 2);
            expect(getErrors(result)).toContain('Duplicate query function parameter name: "query".');
            expect(getErrors(result)).toContain('Duplicate query function type name: "search".');
        });
    });

    describe("Link Validation", () => {
        it("should detect link referencing non-existent source object type", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType()],
                linkTypes: [
                    {
                        id: "badLinkSource",
                        source: {
                            objectType: "NonExistent",
                            name: "missingSource",
                            displayName: "Missing Source",
                        },
                        target: {
                            objectType: "Employee",
                            name: "employee",
                            displayName: "Employee",
                        },
                        foreignKey: "employeeId",
                        cardinality: "one" as const,
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Source object type "NonExistent" does not exist.');
        });

        it("should detect link referencing non-existent target object type", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType()],
                linkTypes: [
                    {
                        id: "badLinkTarget",
                        source: {
                            objectType: "Employee",
                            name: "missingTarget",
                            displayName: "Missing Target",
                        },
                        target: {
                            objectType: "NonExistent",
                            name: "unknown",
                            displayName: "Unknown",
                        },
                        foreignKey: "employeeId",
                        cardinality: "many" as const,
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Target object type "NonExistent" does not exist.');
        });

        it("should validate links with valid object type references", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ name: "Author" }), minimalObjectType({ name: "Post" })],
                linkTypes: [
                    {
                        id: "authorPosts",
                        source: {
                            objectType: "Author",
                            name: "posts",
                            displayName: "Posts",
                        },
                        target: {
                            objectType: "Post",
                            name: "author",
                            displayName: "Author",
                        },
                        foreignKey: "employeeId",
                        cardinality: "many" as const,
                    },
                ],
            };

            expectOk(validate(ontology));
        });
    });

    describe("Ref Resolution", () => {
        it("should detect unknown value type references in properties", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Employee",
                        displayName: "Employee",
                        pluralDisplayName: "Employees",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            {
                                name: "address",
                                displayName: "Address",
                                type: o.ref({ name: "UnknownType" }),
                            },
                        ],
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Unknown value type reference: "UnknownType".');
        });

        it("should detect unknown value type references in query function types", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                queryFunctionTypes: [
                    {
                        name: "lookup",
                        displayName: "Lookup",
                        parameters: [
                            {
                                name: "filter",
                                displayName: "Filter",
                                type: o.ref({ name: "MissingFilter" }),
                            },
                        ],
                        returnType: o.ref({ name: "MissingResult" }),
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 2);
            expect(getErrors(result)).toContain('Unknown value type reference: "MissingFilter".');
            expect(getErrors(result)).toContain('Unknown value type reference: "MissingResult".');
        });

        it("should resolve refs to declared value types", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                types: [
                    {
                        name: "Address",
                        type: o.struct({
                            fields: [{ name: "city", displayName: "City", type: o.string({}) }],
                        }),
                    },
                ],
                objectTypes: [
                    {
                        name: "Employee",
                        displayName: "Employee",
                        pluralDisplayName: "Employees",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            {
                                name: "address",
                                displayName: "Address",
                                type: o.ref({ name: "Address" }),
                            },
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });

        it("should detect unknown object type references", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Employee",
                        displayName: "Employee",
                        pluralDisplayName: "Employees",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            {
                                name: "managerId",
                                displayName: "Manager ID",
                                type: o.objectReference({ objectType: "Manager" }),
                            },
                        ],
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Unknown object type reference: "Manager".');
        });

        it("should resolve object references to declared object types", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Manager",
                        displayName: "Manager",
                        pluralDisplayName: "Managers",
                        primaryKey: "id",
                        properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
                    },
                    {
                        name: "Employee",
                        displayName: "Employee",
                        pluralDisplayName: "Employees",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            {
                                name: "managerId",
                                displayName: "Manager ID",
                                type: o.objectReference({ objectType: "Manager" }),
                            },
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });
    });

    describe("Attachment Type", () => {
        it("should validate properties with attachment type", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Document",
                        displayName: "Document",
                        pluralDisplayName: "Documents",
                        primaryKey: "docId",
                        properties: [
                            { name: "docId", displayName: "Doc ID", type: o.string({}) },
                            { name: "file", displayName: "File", type: o.attachment({}) },
                            {
                                name: "thumbnail",
                                displayName: "Thumbnail",
                                type: o.optional({ type: o.attachment({}) }),
                            },
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });

        it("should validate attachment media type constraints", () => {
            const valid: OntologyIR = {
                ...emptyOntology,
                types: [
                    {
                        name: "Image",
                        type: o.attachment({
                            constraint: {
                                size: { min: 1, max: 10_000_000 },
                                content: o.AttachmentContentConstraint.image({
                                    mediaTypes: ["image/png", "image/jpeg"],
                                    dimensions: {
                                        width: { min: 320, max: 4096 },
                                        height: { min: 320, max: 4096 },
                                    },
                                }),
                            },
                        }),
                    },
                ],
            };
            expectOk(validate(valid));

            const invalid: OntologyIR = {
                ...emptyOntology,
                types: [
                    {
                        name: "Image",
                        type: o.attachment({
                            constraint: {
                                size: { min: 10, max: 1 },
                                content: o.AttachmentContentConstraint.image({
                                    mediaTypes: ["image/avif" as never],
                                    dimensions: {
                                        width: { min: -1 },
                                    },
                                }),
                            },
                        }),
                    },
                ],
            };
            const errors = getErrors(validate(invalid));
            expect(errors).toContain('Unsupported image media type: "image/avif".');
            expect(errors).toContain("Range min must be less than or equal to max.");
            expect(errors).toContain("Range min must be a finite, non-negative number.");
        });
    });

    describe("Action Validation", () => {
        it("should validate action defaults and logic steps", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Task",
                        displayName: "Task",
                        pluralDisplayName: "Tasks",
                        primaryKey: "taskId",
                        properties: [
                            { name: "taskId", displayName: "Task ID", type: o.string({}) },
                            { name: "title", displayName: "Title", type: o.string({}) },
                            { name: "updatedAt", displayName: "Updated At", type: o.timestamp({}) },
                        ],
                    },
                ],
                actionTypes: [
                    {
                        name: "createTask",
                        displayName: "Create Task",
                        parameters: [
                            {
                                name: "title",
                                displayName: "Title",
                                type: o.string({}),
                            },
                            {
                                name: "__taskId",
                                displayName: "Task ID",
                                type: o.optional({ type: o.string({}) }),
                                defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                            },
                            {
                                name: "__now",
                                displayName: "Now",
                                type: o.optional({ type: o.timestamp({}) }),
                                defaultValue: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                            },
                        ],
                        logic: [
                            o.ActionLogicStep.createObject({
                                objectType: "Task",
                                values: [
                                    {
                                        property: ["taskId"],
                                        value: o.Expression.valueReference({
                                            path: ["__taskId"],
                                        }),
                                    },
                                    {
                                        property: ["title"],
                                        value: o.Expression.valueReference({
                                            path: ["title"],
                                        }),
                                    },
                                    {
                                        property: ["updatedAt"],
                                        value: o.Expression.valueReference({
                                            path: ["__now"],
                                        }),
                                    },
                                ],
                            }),
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });

        it("should validate value-reference action parameter defaults", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType()],
                actionTypes: [
                    {
                        name: "updateEmployee",
                        displayName: "Update Employee",
                        parameters: [
                            {
                                name: "employee",
                                displayName: "Employee",
                                type: o.objectReference({ objectType: "Employee" }),
                            },
                            {
                                name: "name",
                                displayName: "Name",
                                type: o.string({}),
                                defaultValue: o.Expression.valueReference({
                                    path: ["employee", "name"],
                                }),
                            },
                        ],
                        logic: [],
                    },
                ],
            };

            expectOk(validate(ontology));
        });

        it("should detect incompatible value-reference defaults", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType()],
                actionTypes: [
                    {
                        name: "updateEmployee",
                        displayName: "Update Employee",
                        parameters: [
                            {
                                name: "employee",
                                displayName: "Employee",
                                type: o.objectReference({ objectType: "Employee" }),
                            },
                            {
                                name: "count",
                                displayName: "Count",
                                type: o.integer({}),
                                defaultValue: o.Expression.valueReference({
                                    path: ["employee", "name"],
                                }),
                            },
                        ],
                        logic: [],
                    },
                ],
            };

            expect(getErrors(validate(ontology))).toContain(
                'Default value for "count" has an incompatible type.'
            );
        });

        it("should detect invalid action parameter references", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType()],
                actionTypes: [
                    {
                        name: "renameEmployee",
                        displayName: "Rename Employee",
                        parameters: [
                            {
                                name: "employee",
                                displayName: "Employee",
                                type: o.objectReference({ objectType: "Employee" }),
                            },
                        ],
                        logic: [
                            o.ActionLogicStep.updateObject({
                                object: {
                                    path: ["employee", "name"],
                                },
                                values: [],
                            }),
                        ],
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain(
                "Action targets must point directly to an object reference parameter."
            );
        });
    });

    describe("Literal Expression", () => {
        it("should validate an action with a literal default value", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Task",
                        displayName: "Task",
                        pluralDisplayName: "Tasks",
                        primaryKey: "taskId",
                        properties: [
                            { name: "taskId", displayName: "Task ID", type: o.string({}) },
                            { name: "status", displayName: "Status", type: o.string({}) },
                        ],
                    },
                ],
                actionTypes: [
                    {
                        name: "createTask",
                        displayName: "Create Task",
                        parameters: [
                            {
                                name: "taskId",
                                displayName: "Task ID",
                                type: o.string({}),
                                defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                            },
                            {
                                name: "status",
                                displayName: "Status",
                                type: o.string({}),
                                defaultValue: o.Expression.literal({ value: "open" }),
                            },
                        ],
                        logic: [
                            o.ActionLogicStep.createObject({
                                objectType: "Task",
                                values: [
                                    {
                                        property: ["taskId"],
                                        value: o.Expression.valueReference({ path: ["taskId"] }),
                                    },
                                    {
                                        property: ["status"],
                                        value: o.Expression.valueReference({ path: ["status"] }),
                                    },
                                ],
                            }),
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });

        it("should validate literal expressions in property assignments", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        name: "Task",
                        displayName: "Task",
                        pluralDisplayName: "Tasks",
                        primaryKey: "taskId",
                        properties: [
                            { name: "taskId", displayName: "Task ID", type: o.string({}) },
                            { name: "status", displayName: "Status", type: o.string({}) },
                        ],
                    },
                ],
                actionTypes: [
                    {
                        name: "createTask",
                        displayName: "Create Task",
                        parameters: [
                            {
                                name: "taskId",
                                displayName: "Task ID",
                                type: o.string({}),
                            },
                        ],
                        logic: [
                            o.ActionLogicStep.createObject({
                                objectType: "Task",
                                values: [
                                    {
                                        property: ["taskId"],
                                        value: o.Expression.valueReference({ path: ["taskId"] }),
                                    },
                                    {
                                        property: ["status"],
                                        value: o.Expression.literal({ value: "open" }),
                                    },
                                ],
                            }),
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });
    });

    describe("Context Validation", () => {
        const userObjectType = {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        };

        it("validates context.user references in action logic", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                contextType: o.struct({
                    fields: [
                        {
                            name: "user",
                            displayName: "User",
                            type: o.objectReference({ objectType: "User" }),
                        },
                    ],
                }),
                objectTypes: [
                    userObjectType,
                    {
                        name: "Task",
                        displayName: "Task",
                        pluralDisplayName: "Tasks",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            {
                                name: "createdBy",
                                displayName: "Created by",
                                type: o.objectReference({ objectType: "User" }),
                            },
                        ],
                    },
                ],
                actionTypes: [
                    {
                        name: "createTask",
                        displayName: "Create task",
                        parameters: [],
                        logic: [
                            o.ActionLogicStep.createObject({
                                objectType: "Task",
                                values: [
                                    {
                                        property: ["id"],
                                        value: o.Expression.literal({
                                            value: "task-1",
                                        }),
                                    },
                                    {
                                        property: ["createdBy"],
                                        value: o.Expression.contextReference({
                                            path: ["user"],
                                        }),
                                    },
                                ],
                            }),
                        ],
                    },
                ],
            };

            expectOk(validate(ontology));
        });

        it("allows context.user to optionally reference any object type", () => {
            expectOk(
                validate({
                    ...emptyOntology,
                    objectTypes: [
                        {
                            name: "Membership",
                            displayName: "Membership",
                            pluralDisplayName: "Memberships",
                            primaryKey: "id",
                            properties: [
                                {
                                    name: "id",
                                    displayName: "ID",
                                    type: o.string({}),
                                },
                            ],
                        },
                    ],
                    contextType: o.struct({
                        fields: [
                            {
                                name: "user",
                                displayName: "User",
                                type: o.optional({
                                    type: o.objectReference({
                                        objectType: "Membership",
                                    }),
                                }),
                            },
                        ],
                    }),
                })
            );
        });

        it("rejects a non-reference type for reserved context.user", () => {
            const result = validate({
                ...emptyOntology,
                contextType: o.struct({
                    fields: [
                        {
                            name: "user",
                            displayName: "User",
                            type: o.string({}),
                        },
                    ],
                }),
            });

            expectErr(result, 1);
            expect(getErrors(result)).toContain('Reserved context field "user" must be an object reference.');
        });
    });

    describe("Blog Example", () => {
        it("should validate the blog example ontology", async () => {
            const { default: blogOntology } = await import("../examples/blog.js");
            expectOk(validate(blogOntology));
        });
    });

    describe("Ontology Ontology", () => {
        it("should validate the ontology ontology (self-describing)", async () => {
            const { default: ontologyOntology } = await import("../meta/ontology.js");
            expectOk(validate(ontologyOntology));
        });

        it("should contain ObjectType, ValueType, LinkType, and ActionType as object types", async () => {
            const { default: ontologyOntology } = await import("../meta/ontology.js");
            const objectTypeNames = ontologyOntology.objectTypes.map((ot) => ot.name);
            expect(objectTypeNames).toContain("ObjectType");
            expect(objectTypeNames).toContain("ValueType");
            expect(objectTypeNames).toContain("LinkType");
            expect(objectTypeNames).toContain("ActionType");
        });

        it("should have links from LinkType to ObjectType for source and target metadata", async () => {
            const { default: ontologyOntology } = await import("../meta/ontology.js");
            const sourceNames = ontologyOntology.linkTypes.map((lt) => lt.source.name);
            expect(sourceNames).toContain("outgoingLinkTypes");
            expect(sourceNames).toContain("incomingLinkTypes");

            const targetNames = ontologyOntology.linkTypes.map((lt) => lt.target.name);
            expect(targetNames).toContain("source");
            expect(targetNames).toContain("target");
        });
    });
});
