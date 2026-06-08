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
