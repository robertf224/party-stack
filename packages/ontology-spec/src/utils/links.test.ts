import { describe, expect, expectTypeOf, it } from "vitest";
import { defineOntology } from "../infer.js";
import { o, type OntologyIR } from "../ir/index.js";
import { isRelatedFromForeignKeySource, resolveRelatedLink } from "./links.js";
import type { RelatedName, RelatedTargetObjectType } from "./links.js";

function objectType(name: string, properties: string[]): OntologyIR["objectTypes"][number] {
    return {
        name,
        displayName: name,
        pluralDisplayName: `${name}s`,
        primaryKey: "id",
        properties: properties.map((property) => ({
            name: property,
            displayName: property,
            type: o.string({}),
        })),
    };
}

describe("resolveRelatedLink", () => {
    it("infers link names and returns the matching link", () => {
        const ir = defineOntology({
            types: [],
            objectTypes: [objectType("Post", ["id", "authorId"]), objectType("Author", ["id"])],
            linkTypes: [
                {
                    id: "postAuthor",
                    source: {
                        objectType: "Post",
                        name: "posts",
                        displayName: "Posts",
                    },
                    target: {
                        objectType: "Author",
                        name: "author",
                        displayName: "Author",
                    },
                    foreignKey: "authorId",
                    cardinality: "many",
                },
            ],
            actionTypes: [],
            queryFunctionTypes: [],
        });

        const hop = resolveRelatedLink(ir, "Post", "author");
        expectTypeOf(hop?.target.objectType).toEqualTypeOf<"Author" | undefined>();
    });

    it("resolves a foreign-key owner hop as to-one", () => {
        const ir = {
            objectTypes: [objectType("Post", ["id", "authorId"]), objectType("Author", ["id"])],
            linkTypes: [
                {
                    id: "postAuthor",
                    source: {
                        objectType: "Post",
                        name: "posts",
                        displayName: "Posts",
                    },
                    target: {
                        objectType: "Author",
                        name: "author",
                        displayName: "Author",
                    },
                    foreignKey: "authorId",
                    cardinality: "many" as const,
                },
            ],
        };

        expect(resolveRelatedLink(ir, "Post", "author")).toBe(ir.linkTypes[0]);
        expect(resolveRelatedLink(ir, "Author", "posts")).toBe(ir.linkTypes[0]);
    });

    it("distinguishes directions on self-referential links", () => {
        const ir = defineOntology({
            types: [],
            actionTypes: [],
            queryFunctionTypes: [],
            objectTypes: [objectType("Employee", ["id", "managerId"])],
            linkTypes: [
                {
                    id: "employeeManager",
                    source: {
                        objectType: "Employee",
                        name: "reports",
                        displayName: "Reports",
                    },
                    target: {
                        objectType: "Employee",
                        name: "manager",
                        displayName: "Manager",
                    },
                    foreignKey: "managerId",
                    cardinality: "many" as const,
                },
            ],
        });

        const link = ir.linkTypes[0]!;
        expect(resolveRelatedLink(ir, "Employee", "manager")).toBe(link);
        expect(isRelatedFromForeignKeySource(link, "Employee", "manager")).toBe(true);
        expect(resolveRelatedLink(ir, "Employee", "reports")).toBe(link);
        expect(isRelatedFromForeignKeySource(link, "Employee", "reports")).toBe(false);
        expectTypeOf<RelatedName<typeof ir, "Employee">>().toEqualTypeOf<"manager" | "reports">();
        expectTypeOf<RelatedTargetObjectType<typeof ir, "Employee", "reports">>().toEqualTypeOf<"Employee">();
        expectTypeOf(resolveRelatedLink(ir, "Employee", "reports")?.id).toEqualTypeOf<
            "employeeManager" | undefined
        >();
    });
});
