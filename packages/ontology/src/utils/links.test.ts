import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { defineOntology } from "../infer.js";
import { o, type OntologyIR } from "../ir/index.js";
import { isLinkHopFromForeignKeySource, resolveLinkHop } from "./links.js";

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

describe("resolveLinkHop", () => {
    it("infers link names and returns the matching link", () => {
        const ir = defineOntology({
            types: [],
            objectTypes: [objectType("Post", ["id", "authorId"]), objectType("Author", ["id"])],
            linkTypes: [
                {
                    id: "postAuthor",
                    source: { objectType: "Post", name: "posts", displayName: "Posts" },
                    target: { objectType: "Author", name: "author", displayName: "Author" },
                    foreignKey: "authorId",
                    cardinality: "many",
                },
            ],
            actionTypes: [],
            queryFunctionTypes: [],
        });

        const hop = resolveLinkHop(ir, "Post", "author");
        expectTypeOf(hop?.target.objectType).toEqualTypeOf<"Author" | undefined>();
    });

    it("resolves a foreign-key owner hop as to-one", () => {
        const ir = {
            objectTypes: [objectType("Post", ["id", "authorId"]), objectType("Author", ["id"])],
            linkTypes: [
                {
                    id: "postAuthor",
                    source: { objectType: "Post", name: "posts", displayName: "Posts" },
                    target: { objectType: "Author", name: "author", displayName: "Author" },
                    foreignKey: "authorId",
                    cardinality: "many" as const,
                },
            ],
        };

        expect(resolveLinkHop(ir, "Post", "author")).toBe(ir.linkTypes[0]);
        expect(resolveLinkHop(ir, "Author", "posts")).toBe(ir.linkTypes[0]);
    });

    it("distinguishes directions on self-referential links", () => {
        const ir = {
            objectTypes: [objectType("Employee", ["id", "managerId"])],
            linkTypes: [
                {
                    id: "employeeManager",
                    source: { objectType: "Employee", name: "reports", displayName: "Reports" },
                    target: { objectType: "Employee", name: "manager", displayName: "Manager" },
                    foreignKey: "managerId",
                    cardinality: "many" as const,
                },
            ],
        };

        const link = ir.linkTypes[0]!;
        expect(resolveLinkHop(ir, "Employee", "manager")).toBe(link);
        expect(isLinkHopFromForeignKeySource(link, "Employee", "manager")).toBe(true);
        expect(resolveLinkHop(ir, "Employee", "reports")).toBe(link);
        expect(isLinkHopFromForeignKeySource(link, "Employee", "reports")).toBe(false);
    });
});
