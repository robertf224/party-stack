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
        expect(result.errors).toHaveLength(count);
    }
}

function getErrors(result: ValidationResult): string[] {
    return result.kind === "ok" ? [] : result.errors.map((e) => e.message);
}

const emptyOntology: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
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

        it("should contain ObjectType, ValueType, and LinkType as object types", async () => {
            const { default: ontologyOntology } = await import("../meta/ontology.js");
            const objectTypeNames = ontologyOntology.objectTypes.map((ot) => ot.name);
            expect(objectTypeNames).toContain("ObjectType");
            expect(objectTypeNames).toContain("ValueType");
            expect(objectTypeNames).toContain("LinkType");
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
