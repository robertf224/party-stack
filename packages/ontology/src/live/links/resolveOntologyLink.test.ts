import { describe, expect, it } from "vitest";
import blog from "../../examples/blog.js";
import { o } from "../../ir/index.js";
import { OntologyLinkError, resolveOntologyLink } from "./resolveOntologyLink.js";
import type { OntologyIR } from "../../ir/index.js";

/** Matches Foundry meta conversion: FK owner is `source`, side names are outbound from each endpoint. */
const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Employee",
            displayName: "Employee",
            pluralDisplayName: "Employees",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "departmentId", displayName: "Department", type: o.string({}) },
            ],
        },
        {
            name: "Department",
            displayName: "Department",
            pluralDisplayName: "Departments",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
    linkTypes: [
        {
            id: "ri.link.employee-department",
            source: {
                objectType: "Employee",
                name: "employees",
                displayName: "Employees",
                cardinality: "many",
            },
            target: {
                objectType: "Department",
                name: "department",
                displayName: "Department",
                cardinality: "one",
            },
            foreignKey: "departmentId",
            cardinality: "many",
        },
        {
            id: "ri.link.non-fk",
            source: {
                objectType: "Employee",
                name: "peerOf",
                displayName: "Peer of",
                cardinality: "many",
            },
            target: {
                objectType: "Employee",
                name: "peers",
                displayName: "Peers",
                cardinality: "many",
            },
            cardinality: "many",
        },
    ],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("resolveOntologyLink", () => {
    it("follows the canonical opposite-side name convention used by existing IR", () => {
        expect(resolveOntologyLink(blog, "Post", { sideName: "author" })).toMatchObject({
            targetObjectType: "Author",
            sideName: "author",
            inverseSideName: "posts",
            foreignKey: "authorId",
            cardinality: "one",
        });
        expect(resolveOntologyLink(blog, "Author", { sideName: "posts" })).toMatchObject({
            targetObjectType: "Post",
            sideName: "posts",
            inverseSideName: "author",
            foreignKey: "authorId",
            cardinality: "many",
        });
        expect(resolveOntologyLink(blog, "Comment", { sideName: "author" })).toMatchObject({
            targetObjectType: "Author",
            sideName: "author",
            inverseSideName: "comment",
            foreignKey: "authorId",
            cardinality: "one",
        });
    });

    it("resolves forward and reverse FK sides", () => {
        expect(resolveOntologyLink(ir, "Employee", { sideName: "department" })).toMatchObject({
            targetObjectType: "Department",
            sideName: "department",
            foreignKey: "departmentId",
            foreignKeyOnCurrentObject: true,
            cardinality: "one",
        });

        expect(resolveOntologyLink(ir, "Department", { sideName: "employees" })).toMatchObject({
            targetObjectType: "Employee",
            sideName: "employees",
            foreignKey: "departmentId",
            foreignKeyOnCurrentObject: false,
            cardinality: "many",
        });
    });

    it("resolves by stable link id", () => {
        expect(resolveOntologyLink(ir, "Employee", { id: "ri.link.employee-department" })).toMatchObject({
            sideName: "department",
            targetObjectType: "Department",
        });
    });

    it("keeps non-FK links resolvable", () => {
        expect(resolveOntologyLink(ir, "Employee", { sideName: "peers" })).toMatchObject({
            foreignKey: undefined,
            sideName: "peers",
            targetObjectType: "Employee",
        });
    });

    it("throws for unknown links", () => {
        expect(() => resolveOntologyLink(ir, "Employee", { sideName: "missing" })).toThrow(
            OntologyLinkError
        );
    });
});
