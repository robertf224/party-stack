import { describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { generateOntology } from "./ontology.js";
import type { OntologyIR } from "../ir/index.js";

describe("generateOntology", () => {
    it("preserves object title property metadata", () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Employee",
                    displayName: "Employee",
                    pluralDisplayName: "Employees",
                    primaryKey: "id",
                    title: "name",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        { name: "name", displayName: "Name", type: o.string({}) },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        };

        expect(generateOntology(ontology)).toContain('title: "name"');
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
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
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
        };

        const output = generateOntology(ontology);
        expect(output).toContain("contextType: o.struct");
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
                            defaultValue: o.Expression.valueReference({
                                path: ["employee", "name"],
                            }),
                        },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        };

        const output = generateOntology(ontology);
        expect(output).toContain("o.Expression.valueReference");
        expect(output).toContain('objectType: "Employee"');
    });
});
