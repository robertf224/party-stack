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
    valueTypes: [],
    objectTypes: [],
    linkTypes: [],
};

const minimalObjectType = (overrides?: Partial<OntologyIR["objectTypes"][number]>) => ({
    apiName: "Employee",
    displayName: "Employee",
    primaryKey: "employeeId",
    properties: [
        { apiName: "employeeId", displayName: "Employee ID", type: o.string({}) },
        { apiName: "name", displayName: "Name", type: o.string({}) },
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
        it("should detect duplicate object type apiNames", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType(), minimalObjectType()],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate object type apiName: "Employee".');
        });

        it("should detect duplicate value type apiNames", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                valueTypes: [
                    { apiName: "Address", displayName: "Address", type: o.struct({ fields: [] }) },
                    { apiName: "Address", displayName: "Address", type: o.struct({ fields: [] }) },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate value type apiName: "Address".');
        });

        it("should detect duplicate link type apiNames", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType({ apiName: "A" }), minimalObjectType({ apiName: "B" })],
                linkTypes: [
                    {
                        apiName: "aToB",
                        displayName: "A to B",
                        sourceObjectType: "A",
                        targetObjectType: "B",
                        cardinality: "many" as const,
                    },
                    {
                        apiName: "aToB",
                        displayName: "A to B again",
                        sourceObjectType: "A",
                        targetObjectType: "B",
                        cardinality: "one" as const,
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate link type apiName: "aToB".');
        });

        it("should detect duplicate property apiNames within an object type", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [
                    {
                        apiName: "Employee",
                        displayName: "Employee",
                        primaryKey: "id",
                        properties: [
                            { apiName: "id", displayName: "ID", type: o.string({}) },
                            { apiName: "id", displayName: "ID Duplicate", type: o.string({}) },
                        ],
                    },
                ],
            };

            const result = validate(ontology);
            expectErr(result, 1);
            expect(getErrors(result)).toContain('Duplicate property apiName: "id".');
        });
    });

    describe("Link Validation", () => {
        it("should detect link referencing non-existent source object type", () => {
            const ontology: OntologyIR = {
                ...emptyOntology,
                objectTypes: [minimalObjectType()],
                linkTypes: [
                    {
                        apiName: "badLink",
                        displayName: "Bad Link",
                        sourceObjectType: "NonExistent",
                        targetObjectType: "Employee",
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
                        apiName: "badLink",
                        displayName: "Bad Link",
                        sourceObjectType: "Employee",
                        targetObjectType: "NonExistent",
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
                objectTypes: [
                    minimalObjectType({ apiName: "Author" }),
                    minimalObjectType({ apiName: "Post" }),
                ],
                linkTypes: [
                    {
                        apiName: "authorPosts",
                        displayName: "Author Posts",
                        sourceObjectType: "Author",
                        targetObjectType: "Post",
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
                        apiName: "Employee",
                        displayName: "Employee",
                        primaryKey: "id",
                        properties: [
                            { apiName: "id", displayName: "ID", type: o.string({}) },
                            {
                                apiName: "address",
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
                valueTypes: [
                    {
                        apiName: "Address",
                        displayName: "Address",
                        type: o.struct({
                            fields: [{ name: "city", displayName: "City", type: o.string({}) }],
                        }),
                    },
                ],
                objectTypes: [
                    {
                        apiName: "Employee",
                        displayName: "Employee",
                        primaryKey: "id",
                        properties: [
                            { apiName: "id", displayName: "ID", type: o.string({}) },
                            {
                                apiName: "address",
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
                        apiName: "Document",
                        displayName: "Document",
                        primaryKey: "docId",
                        properties: [
                            { apiName: "docId", displayName: "Doc ID", type: o.string({}) },
                            { apiName: "file", displayName: "File", type: o.attachment({}) },
                            {
                                apiName: "thumbnail",
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
            const { blogOntology } = await import("../examples/blog.js");
            expectOk(validate(blogOntology));
        });
    });

    describe("Ontology Ontology", () => {
        it("should validate the ontology ontology (self-describing)", async () => {
            const { ontologyOntology } = await import("./ontology.js");
            expectOk(validate(ontologyOntology));
        });

        it("should contain ObjectType, ValueType, and LinkType as object types", async () => {
            const { ontologyOntology } = await import("./ontology.js");
            const objectTypeNames = ontologyOntology.objectTypes.map((ot) => ot.apiName);
            expect(objectTypeNames).toContain("ObjectType");
            expect(objectTypeNames).toContain("ValueType");
            expect(objectTypeNames).toContain("LinkType");
        });

        it("should have links from LinkType to ObjectType for source and target", async () => {
            const { ontologyOntology } = await import("./ontology.js");
            const linkNames = ontologyOntology.linkTypes.map((lt) => lt.apiName);
            expect(linkNames).toContain("linkTypeSource");
            expect(linkNames).toContain("linkTypeTarget");
        });
    });
});
