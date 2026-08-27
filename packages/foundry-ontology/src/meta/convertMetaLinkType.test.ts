import { describe, expect, it } from "vitest";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import type { ObjectTypeFullMetadata } from "@osdk/foundry.ontologies";

function objectType(opts: {
    apiName: string;
    linkTypes: ObjectTypeFullMetadata["linkTypes"];
}): ObjectTypeFullMetadata {
    return {
        objectType: {
            apiName: opts.apiName,
            displayName: opts.apiName,
            status: "ACTIVE",
            description: undefined,
            pluralDisplayName: `${opts.apiName}s`,
            primaryKey: "id",
            properties: {
                id: {
                    dataType: { type: "string" },
                    rid: `ri.ontology.main.property.${opts.apiName}.id`,
                    apiName: "id",
                    displayName: "ID",
                    status: "ACTIVE",
                    visibility: "NORMAL",
                },
            },
            rid: `ri.ontology.main.object-type.${opts.apiName}`,
            titleProperty: "id",
        },
        linkTypes: opts.linkTypes,
        sharedPropertyTypeMapping: {},
        implementsInterfaces: [],
        implementsInterfaces2: {},
    } as unknown as ObjectTypeFullMetadata;
}

describe("convertFoundryMetaLinkTypes", () => {
    it("converts FK-backed links", () => {
        const linkRid = "ri.ontology.main.link-type.post-author";
        const result = convertFoundryMetaLinkTypes([
            objectType({
                apiName: "Post",
                linkTypes: [
                    {
                        apiName: "posts",
                        displayName: "Posts",
                        status: "ACTIVE",
                        objectTypeApiName: "Post",
                        cardinality: "MANY",
                        foreignKeyPropertyApiName: "authorId",
                        linkTypeRid: linkRid,
                    },
                ],
            }),
            objectType({
                apiName: "Author",
                linkTypes: [
                    {
                        apiName: "author",
                        displayName: "Author",
                        status: "ACTIVE",
                        objectTypeApiName: "Author",
                        cardinality: "ONE",
                        linkTypeRid: linkRid,
                    },
                ],
            }),
        ]);

        expect(result).toEqual([
            {
                id: linkRid,
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
        ]);
    });

    it("omits non-FK object-backed links without synthesizing a foreign key", () => {
        const linkRid = "ri.ontology.main.link-type.author-editor";
        const result = convertFoundryMetaLinkTypes([
            objectType({
                apiName: "Author",
                linkTypes: [
                    {
                        apiName: "editedBy",
                        displayName: "Edited by",
                        status: "ACTIVE",
                        objectTypeApiName: "Author",
                        cardinality: "ONE",
                        linkTypeRid: linkRid,
                    },
                    {
                        apiName: "edits",
                        displayName: "Edits",
                        status: "ACTIVE",
                        objectTypeApiName: "Author",
                        cardinality: "MANY",
                        linkTypeRid: linkRid,
                    },
                ],
            }),
        ]);

        expect(result).toEqual([]);
        expect(result.every((link) => Boolean(link.foreignKey))).toBe(true);
    });
});
