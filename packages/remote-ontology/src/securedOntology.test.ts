import { o, type OntologyIR } from "@party-stack/ontology";
import { describe, expect, it } from "vite-plus/test";
import {
    applyFixedActionParameterValues,
    getVisibleActionParameterNames,
    pickVisibleActionParameters,
    projectRemoteOntologyIR,
} from "./securedOntology.js";

function contextEmail() {
    return o.Expression.getAt({ source: o.Expression.contextReference({ name: "user" }), path: ["email"] });
}

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
                        { property: ["id"], value: o.Expression.inputReference({ name: "id" }) },
                        { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.inputReference({ name: "ownerEmail" }),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.inputReference({ name: "updatedAt" }),
                        },
                        { property: ["directContext"], value: contextEmail() },
                        { property: ["secret"], value: o.Expression.inputReference({ name: "title" }) },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [
        { name: "publicSearch", displayName: "Public search", parameters: [], returnType: o.string({}) },
        { name: "privateSearch", displayName: "Private search", parameters: [], returnType: o.string({}) },
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
                createNote: { ownerEmail: contextEmail(), updatedAt: o.Expression.now({}) },
            },
        });

        const action = projected.actionTypes[0]!;
        expect(action.parameters.map((parameter) => parameter.name)).toEqual(["id", "title"]);
        expect(projected.objectTypes).toHaveLength(1);
        const step = action.logic[0]!;
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;

        expect(step.value.values).toEqual([
            { property: ["id"], value: o.Expression.inputReference({ name: "id" }) },
            { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
            { property: ["updatedAt"], value: o.Expression.now({}) },
        ]);
    });

    it("projects map expressions over visible parameters", () => {
        const mapping = o.Expression.map({
            source: o.Expression.inputReference({ name: "entries" }),
            binding: "entry",
            body: o.Expression.struct({
                fields: [
                    {
                        name: "renamedCode",
                        value: o.Expression.getAt({
                            source: o.Expression.localReference({ name: "entry" }),
                            path: ["code"],
                        }),
                    },
                ],
            }),
        });
        const action = ir.actionTypes[0]!;
        const step = action.logic[0]!;
        if (step.kind !== "createObject") {
            throw new Error("Expected create-object logic.");
        }
        const projected = projectRemoteOntologyIR({
            ir: {
                ...ir,
                objectTypes: ir.objectTypes.map((objectType) => ({
                    ...objectType,
                    properties: [
                        ...objectType.properties,
                        {
                            name: "entries",
                            displayName: "Entries",
                            type: o.list({ elementType: o.unknown({}) }),
                        },
                    ],
                })),
                actionTypes: [
                    {
                        ...action,
                        parameters: [
                            ...action.parameters,
                            {
                                name: "entries",
                                displayName: "Entries",
                                type: o.list({ elementType: o.unknown({}) }),
                            },
                        ],
                        logic: [
                            {
                                ...step,
                                value: {
                                    ...step.value,
                                    values: [...step.value.values, { property: ["entries"], value: mapping }],
                                },
                            },
                        ],
                    },
                ],
            },
            serverContext: {},
            allowedObjectTypeProperties: {
                Note: ["id", "title", "ownerEmail", "updatedAt", "directContext", "entries"],
            },
        });
        const projectedStep = projected.actionTypes[0]!.logic[0]!;
        expect(projectedStep.kind).toBe("createObject");
        if (projectedStep.kind !== "createObject") {
            return;
        }

        expect(projectedStep.value.values).toContainEqual({ property: ["entries"], value: mapping });
    });

    it("projects action defaults through object and property authorization", () => {
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
                                defaultValue: o.Expression.getAt({
                                    source: o.Expression.objectLookup({
                                        reference: o.Expression.inputReference({ name: "employee" }),
                                    }),
                                    path: ["name"],
                                }),
                            },
                            {
                                name: "notes",
                                displayName: "Notes",
                                type: o.string({}),
                                defaultValue: o.Expression.literal({ value: "Default" }),
                            },
                        ],
                        logic: [],
                    },
                ],
            },
            serverContext: {},
            allowedObjectTypeProperties: { Employee: ["id"] },
        });

        expect(projected.actionTypes[0]?.parameters[1]?.defaultValue).toBeUndefined();
        expect(projected.actionTypes[0]?.parameters[2]?.defaultValue).toEqual(
            o.Expression.literal({ value: "Default" })
        );
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
                        source: { objectType: "Note", name: "notes", displayName: "Notes" },
                        target: { objectType: "Hidden", name: "hidden", displayName: "Hidden" },
                        foreignKey: "id",
                        cardinality: "one",
                    },
                ],
            },
            serverContext: {},
            filterSchemaByAuthorization: true,
            allowedObjectTypeProperties: { Note: ["id", "title", "ownerEmail"] },
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
        expect(projected.actionTypes.map((action) => action.name)).toEqual(["createNote"]);
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
            fixedActionParameterValues: { createNote: { ownerEmail: contextEmail() } },
        });

        const action = projected.actionTypes[0]!;
        expect(action.parameters.map((parameter) => parameter.name)).toEqual(["id", "title", "updatedAt"]);
        const step = action.logic[0]!;
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;

        expect(step.value.values).toContainEqual({ property: ["ownerEmail"], value: contextEmail() });
        expect(step.value.values).toContainEqual({ property: ["directContext"], value: contextEmail() });
    });

    it("strips context references when context is projected but not forwarded", () => {
        const projected = projectRemoteOntologyIR({
            ir,
            serverContext: { user: { email: "alice@example.com" }, serviceUser: { token: "secret" } },
            clientContext: { user: { email: "alice@example.com" } },
            clientContextMode: "projected",
            allowedObjectTypeProperties: {
                Note: ["id", "title", "ownerEmail", "updatedAt", "directContext"],
            },
            fixedActionParameterValues: { createNote: { ownerEmail: contextEmail() } },
        });

        const step = projected.actionTypes[0]!.logic[0]!;
        expect(step.kind).toBe("createObject");
        if (step.kind !== "createObject") return;

        expect(step.value.values).not.toContainEqual({ property: ["ownerEmail"], value: contextEmail() });
        expect(step.value.values).not.toContainEqual({ property: ["directContext"], value: contextEmail() });
    });
});

describe("visible action parameter helpers", () => {
    it("derives visible parameter names from fixed parameter policy", () => {
        const action = ir.actionTypes[0]!;
        expect([
            ...getVisibleActionParameterNames("createNote", action.parameters, {
                createNote: { ownerEmail: contextEmail() },
            }),
        ]).toEqual(["id", "title", "updatedAt"]);
    });

    it("filters resolved parameters to visible names only", () => {
        const action = ir.actionTypes[0]!;
        expect(
            pickVisibleActionParameters(
                "createNote",
                {
                    id: "note-1",
                    title: "Hello",
                    ownerEmail: "alice@example.com",
                    updatedAt: "2026-05-28T22:11:00.000Z",
                },
                { createNote: { ownerEmail: contextEmail() } },
                action.parameters
            )
        ).toEqual({ id: "note-1", title: "Hello", updatedAt: "2026-05-28T22:11:00.000Z" });
    });
});

describe("fixed action parameter values", () => {
    it("evaluates fixed values after client parameters so clients cannot override them", () => {
        const parameters = applyFixedActionParameterValues({
            ctx: { user: { email: "alice@example.com" } },
            actionType: "createNote",
            parameters: { title: "Hello", ownerEmail: "mallory@example.com" },
            fixedActionParameterValues: {
                createNote: {
                    ownerEmail: contextEmail(),
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
