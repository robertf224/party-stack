import { describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { generateOntology } from "./ontology.js";
import type { OntologyIR } from "../ir/index.js";

describe("generateOntology", () => {
    it("leaves provider ids out of generated source", () => {
        const output = generateOntology({
            types: [{ id: "provider-status", name: "Status", type: o.string({}) }],
            linkTypes: [
                {
                    id: "provider-link",
                    source: { objectType: "Task", name: "tasks", displayName: "Tasks" },
                    target: { objectType: "Task", name: "parent", displayName: "Parent" },
                    foreignKey: "id",
                    cardinality: "one",
                },
            ],
            queryFunctionTypes: [],
            objectTypes: [
                {
                    id: "provider-object-type",
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "id",
                    properties: [
                        { id: "provider-property", name: "id", displayName: "ID", type: o.string({}) },
                    ],
                },
            ],
            actionTypes: [
                {
                    id: "provider-action",
                    name: "complete",
                    displayName: "Complete",
                    parameters: [],
                    logic: [],
                },
            ],
        });
        expect(output).not.toContain("provider-");
        expect(output).toContain("Task");
    });

    it("preserves object and action presentation metadata", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Employee",
                    displayName: "Employee",
                    pluralDisplayName: "Employees",
                    primaryKey: "id",
                    title: "name",
                    icon: {
                        name: "person",
                        meta: {
                            blueprint: {
                                name: "person",
                            },
                        },
                    },
                    color: "#2d72d2",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        {
                            name: "name",
                            displayName: "Name",
                            type: o.string({
                                suggestions: [
                                    {
                                        value: "Ada",
                                        label: "Ada Lovelace",
                                    },
                                ],
                            }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createEmployee",
                    displayName: "Create employee",
                    icon: { name: "plus-circle" },
                    color: "#15b371",
                    parameters: [],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        };

        const output = generateOntology(ontology);
        expect(output).toContain('title: "name"');
        expect(output).toContain('name: "person"');
        expect(output).toContain('color: "#2d72d2"');
        expect(output).toContain('name: "plus-circle"');
        expect(output).toContain('color: "#15b371"');
        expect(output).toContain("suggestions: [");
        expect(output).toContain('label: "Ada Lovelace"');
    });

    it("preserves the ontology context type", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Membership",
                    displayName: "Membership",
                    pluralDisplayName: "Memberships",
                    primaryKey: "id",
                    properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
            context: {
                type: o.struct({
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
            },
        };

        const output = generateOntology(ontology);
        expect(output).toContain("context:");
        expect(output).toContain("type: o.struct");
        expect(output).toContain('objectType: "Membership"');
    });

    it("preserves value-reference action parameter defaults", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
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
            linkTypes: [],
            actionTypes: [
                {
                    meta: {
                        provider: {
                            kind: "remote",
                        },
                    },
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
                                source: o.Expression.lookup({
                                    reference: o.Expression.inputReference({
                                        name: "employee",
                                    }),
                                }),
                                path: ["name"],
                            }),
                        },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        };

        const output = generateOntology(ontology);
        expect(output).toContain("o.Expression.getAt");
        expect(output).toContain('kind: "lookup"');
        expect(output).toContain('objectType: "Employee"');
        expect(output).toContain("meta: {");
        expect(output).toContain("provider: {");
        expect(output).toContain('kind: "remote"');
    });
});
