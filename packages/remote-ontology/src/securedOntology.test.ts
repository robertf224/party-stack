import { describe, expect, it } from "vitest";
import { o, type OntologyIR } from "@party-stack/ontology";
import { applyFixedActionParameterValues, projectRemoteOntologyIR } from "./securedOntology.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "ownerEmail", displayName: "Owner", type: o.string({}) },
                { name: "updatedAt", displayName: "Updated at", type: o.string({}) },
                { name: "directContext", displayName: "Direct context", type: o.string({}) },
                { name: "secret", displayName: "Secret", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "ownerEmail", displayName: "Owner", type: o.string({}) },
                { name: "updatedAt", displayName: "Updated at", type: o.string({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({ path: ["id"] }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({ path: ["title"] }),
                        },
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.valueReference({ path: ["ownerEmail"] }),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.valueReference({ path: ["updatedAt"] }),
                        },
                        {
                            property: ["directContext"],
                            value: o.Expression.contextReference({ path: ["user", "email"] }),
                        },
                        {
                            property: ["secret"],
                            value: o.Expression.valueReference({ path: ["title"] }),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [
        {
            name: "publicSearch",
            displayName: "Public search",
            parameters: [],
            returnType: o.string({}),
        },
        {
            name: "privateSearch",
            displayName: "Private search",
            parameters: [],
            returnType: o.string({}),
        },
    ],
};

describe("secured ontology projection", () => {
    it("hides fixed parameters and strips hidden context assignments", () => {
        const projected = projectRemoteOntologyIR({
            ir,
            serverContext: { user: { email: "alice@example.com" } },
            allowedObjectTypeProperties: {
                Note: ["id", "title", "ownerEmail", "updatedAt", "directContext"],
            },
            fixedActionParameterValues: {
                createNote: {
                    ownerEmail: o.Expression.contextReference({ path: ["user", "email"] }),
                    updatedAt: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                },
            },
        });

        const action = projected.actionTypes[0]!;
        expect(action.parameters.map((parameter) => parameter.name)).toEqual(["id", "title"]);
        expect(projected.objectTypes).toHaveLength(1);
        const step = action.logic[0]!;
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;

        expect(step.value.values).toEqual([
            {
                property: ["id"],
                value: o.Expression.valueReference({ path: ["id"] }),
            },
            {
                property: ["title"],
                value: o.Expression.valueReference({ path: ["title"] }),
            },
            {
                property: ["updatedAt"],
                value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
            },
        ]);
    });

    it("projects action prefills through object and property authorization", () => {
        const projected = projectRemoteOntologyIR({
            ir: {
                ...ir,
                objectTypes: [
                    ...ir.objectTypes,
                    {
                        name: "Employee",
                        displayName: "Employee",
                        pluralDisplayName: "Employees",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            { name: "name", displayName: "Name", type: o.string({}) },
                        ],
                    },
                ],
                actionTypes: [
                    {
                        name: "updateEmployee",
                        displayName: "Update employee",
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
                                prefills: [
                                    o.ActionParameterPrefill.objectProperty({
                                        fieldPath: [],
                                        parameter: "employee",
                                        property: ["name"],
                                    }),
                                ],
                            },
                            {
                                name: "notes",
                                displayName: "Notes",
                                type: o.string({}),
                                prefills: [
                                    o.ActionParameterPrefill.literal({
                                        fieldPath: [],
                                        value: "Default",
                                    }),
                                ],
                            },
                            {
                                name: "assignee",
                                displayName: "Assignee",
                                type: o.objectReference({ objectType: "Employee" }),
                                prefills: [
                                    o.ActionParameterPrefill.foundryObjectQuery({
                                        fieldPath: [],
                                        objectType: "Employee",
                                        objectSet: {
                                            objectSet: {
                                                transforms: [
                                                    {
                                                        type: "propertyFilter",
                                                        propertyFilter: {
                                                            type: "exactMatch",
                                                            exactMatch: {
                                                                propertyId: "id",
                                                                terms: [
                                                                    {
                                                                        type: "string",
                                                                        string: "employee-1",
                                                                    },
                                                                ],
                                                            },
                                                        },
                                                    },
                                                ],
                                            },
                                        },
                                    }),
                                ],
                            },
                            {
                                name: "manager",
                                displayName: "Manager",
                                type: o.objectReference({ objectType: "Employee" }),
                                prefills: [
                                    o.ActionParameterPrefill.foundryObjectQuery({
                                        fieldPath: [],
                                        objectType: "Employee",
                                        objectSet: {
                                            objectSet: {
                                                transforms: [
                                                    {
                                                        type: "propertyFilter",
                                                        propertyFilter: {
                                                            type: "parameterizedExactMatch",
                                                            parameterizedExactMatch: {
                                                                propertyId: "id",
                                                                terms: [
                                                                    {
                                                                        type: "unresolved",
                                                                        unresolved: {
                                                                            parameterId: "hidden",
                                                                        },
                                                                    },
                                                                ],
                                                            },
                                                        },
                                                    },
                                                ],
                                            },
                                            conditionValues: {
                                                hidden: {
                                                    type: "resolved",
                                                    resolved: {
                                                        value: "employee-2",
                                                    },
                                                },
                                            },
                                        },
                                    }),
                                ],
                            },
                        ],
                        logic: [],
                    },
                ],
            },
            serverContext: {},
            allowedObjectTypeProperties: {
                Employee: ["id"],
            },
            filterSchemaByAuthorization: true,
        });

        expect(projected.actionTypes[0]?.parameters[1]?.prefills).toBeUndefined();
        expect(projected.actionTypes[0]?.parameters[2]?.prefills).toEqual([
            o.ActionParameterPrefill.literal({
                fieldPath: [],
                value: "Default",
            }),
        ]);
        expect(projected.actionTypes[0]?.parameters[3]?.prefills).toEqual([
            o.ActionParameterPrefill.foundryObjectQuery({
                fieldPath: [],
                objectType: "Employee",
                objectSet: {
                    objectSet: {
                        transforms: [
                            {
                                type: "propertyFilter",
                                propertyFilter: {
                                    type: "exactMatch",
                                    exactMatch: {
                                        propertyId: "id",
                                        terms: [
                                            {
                                                type: "string",
                                                string: "employee-1",
                                            },
                                        ],
                                    },
                                },
                            },
                        ],
                    },
                    conditionValues: {},
                },
            }),
        ]);
        expect(projected.actionTypes[0]?.parameters[4]?.prefills).toBeUndefined();
    });

    it("projects authorized object/property/link visibility and prunes unreachable types", () => {
        const projected = projectRemoteOntologyIR({
            ir: {
                ...ir,
                types: [
                    {
                        name: "SecretStruct",
                        type: o.struct({
                            fields: [{ name: "token", displayName: "Token", type: o.string({}) }],
                        }),
                    },
                    {
                        name: "VisibleStruct",
                        type: o.struct({
                            fields: [{ name: "label", displayName: "Label", type: o.string({}) }],
                        }),
                    },
                ],
                objectTypes: [
                    ...ir.objectTypes,
                    {
                        name: "Hidden",
                        displayName: "Hidden",
                        pluralDisplayName: "Hidden",
                        primaryKey: "id",
                        properties: [
                            { name: "id", displayName: "ID", type: o.string({}) },
                            { name: "secret", displayName: "Secret", type: o.ref({ name: "SecretStruct" }) },
                        ],
                    },
                ],
                linkTypes: [
                    {
                        id: "note-hidden",
                        source: {
                            objectType: "Note",
                            name: "notes",
                            displayName: "Notes",
                        },
                        target: {
                            objectType: "Hidden",
                            name: "hidden",
                            displayName: "Hidden",
                        },
                        foreignKey: "id",
                        cardinality: "one",
                    },
                ],
            },
            serverContext: {},
            filterSchemaByAuthorization: true,
            allowedObjectTypeProperties: {
                Note: ["id", "title", "ownerEmail"],
            },
            visibleQueryFunctionTypes: ["publicSearch"],
        });

        expect(projected.objectTypes.map((objectType) => objectType.name)).toEqual(["Note"]);
        expect(projected.objectTypes[0]?.properties.map((property) => property.name)).toEqual([
            "id",
            "title",
            "ownerEmail",
        ]);
        expect(projected.linkTypes).toEqual([]);
        expect(projected.queryFunctionTypes.map((query) => query.name)).toEqual(["publicSearch"]);
        expect(projected.types.map((type) => type.name)).toEqual([]);
    });

    it("retains explicitly visible write-only actions without leaking hidden logic targets", () => {
        const projected = projectRemoteOntologyIR({
            ir,
            serverContext: {},
            filterSchemaByAuthorization: true,
            allowedObjectTypeProperties: {},
            visibleActionTypes: ["createNote"],
            visibleQueryFunctionTypes: [],
        });

        expect(projected.objectTypes).toEqual([]);
        expect(
            projected.actionTypes.map(
                (action) => action.name,
            ),
        ).toEqual(["createNote"]);
        expect(projected.actionTypes[0]?.logic).toEqual([]);
    });

    it("preserves context references exposed in client context", () => {
        const projected = projectRemoteOntologyIR({
            ir,
            serverContext: { user: { email: "alice@example.com" }, serviceUser: "hidden" },
            clientContext: { user: { email: "alice@example.com" } },
            clientContextMode: "forward",
            allowedObjectTypeProperties: {
                Note: ["id", "title", "ownerEmail", "updatedAt", "directContext"],
            },
            fixedActionParameterValues: {
                createNote: {
                    ownerEmail: o.Expression.contextReference({ path: ["user", "email"] }),
                },
            },
        });

        const action = projected.actionTypes[0]!;
        expect(action.parameters.map((parameter) => parameter.name)).toEqual(["id", "title", "updatedAt"]);
        const step = action.logic[0]!;
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;

        expect(step.value.values).toContainEqual({
            property: ["ownerEmail"],
            value: o.Expression.contextReference({ path: ["user", "email"] }),
        });
        expect(step.value.values).toContainEqual({
            property: ["directContext"],
            value: o.Expression.contextReference({ path: ["user", "email"] }),
        });
    });

    it("strips context references when context is projected but not forwarded", () => {
        const projected = projectRemoteOntologyIR({
            ir,
            serverContext: {
                user: { email: "alice@example.com" },
                serviceUser: { token: "secret" },
            },
            clientContext: { user: { email: "alice@example.com" } },
            clientContextMode: "projected",
            allowedObjectTypeProperties: {
                Note: ["id", "title", "ownerEmail", "updatedAt", "directContext"],
            },
            fixedActionParameterValues: {
                createNote: {
                    ownerEmail: o.Expression.contextReference({ path: ["user", "email"] }),
                },
            },
        });

        const step = projected.actionTypes[0]!.logic[0]!;
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;

        expect(step.value.values).not.toContainEqual({
            property: ["ownerEmail"],
            value: o.Expression.contextReference({ path: ["user", "email"] }),
        });
        expect(step.value.values).not.toContainEqual({
            property: ["directContext"],
            value: o.Expression.contextReference({ path: ["user", "email"] }),
        });
    });

});

describe("fixed action parameter values", () => {
    it("evaluates fixed values after client parameters so clients cannot override them", async () => {
        const parameters = await applyFixedActionParameterValues({
            ctx: { user: { email: "alice@example.com" } },
            actionType: "createNote",
            parameters: {
                title: "Hello",
                ownerEmail: "mallory@example.com",
            },
            fixedActionParameterValues: {
                createNote: {
                    ownerEmail: o.Expression.contextReference({ path: ["user", "email"] }),
                    createdAt: o.Expression.literal({ value: "2026-05-28T22:11:00.000Z" }),
                },
            },
        });

        expect(parameters).toEqual({
            title: "Hello",
            ownerEmail: "alice@example.com",
            createdAt: "2026-05-28T22:11:00.000Z",
        });
    });
});
