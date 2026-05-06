import { describe, expect, it } from "vitest";
import { o } from "../ir/generated/builders.js";
import { getTargetValueType, resolveType, unwrapValueType } from "./types.js";
import type { OntologyIR } from "../ir/generated/types.js";

describe("unwrapValueType", () => {
    it("unwraps nested optional and list wrappers", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
        };
        const type = o.optional({
            type: o.list({
                elementType: o.optional({
                    type: o.string({}),
                }),
            }),
        });

        expect(unwrapValueType(ir, type)).toEqual(o.string({}));
    });

    it("unwraps refs through named types", () => {
        const ir: OntologyIR = {
            types: [
                {
                    name: "AttachmentList",
                    type: o.optional({
                        type: o.list({
                            elementType: o.optional({
                                type: o.attachment({}),
                            }),
                        }),
                    }),
                },
            ],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
        };

        expect(unwrapValueType(ir, o.ref({ name: "AttachmentList" }))).toEqual(o.attachment({}));
    });

    it("throws when a ref cannot be resolved", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
        };

        expect(() => unwrapValueType(ir, o.ref({ name: "MissingType" }))).toThrow(
            'Unknown type reference "MissingType".'
        );
    });
});

describe("resolveType", () => {
    it("resolves refs recursively", () => {
        const ir: OntologyIR = {
            types: [
                { name: "AttachmentAlias", type: o.ref({ name: "AttachmentType" }) },
                { name: "AttachmentType", type: o.attachment({}) },
            ],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
        };

        expect(resolveType(ir, o.ref({ name: "AttachmentAlias" }))).toEqual(o.attachment({}));
    });

    it("throws when a ref cannot be resolved", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
        };

        expect(() => resolveType(ir, o.ref({ name: "MissingType" }))).toThrow(
            'Unknown type reference "MissingType".'
        );
    });
});

describe("getTargetValueType", () => {
    it("returns the unwrapped type for a target property", () => {
        const ir: OntologyIR = {
            types: [
                {
                    name: "AttachmentList",
                    type: o.optional({
                        type: o.list({
                            elementType: o.optional({
                                type: o.attachment({}),
                            }),
                        }),
                    }),
                },
            ],
            objectTypes: [
                {
                    name: "Post",
                    displayName: "Post",
                    pluralDisplayName: "Posts",
                    primaryKey: "id",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        {
                            name: "attachments",
                            displayName: "Attachments",
                            type: o.ref({ name: "AttachmentList" }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
        };

        expect(getTargetValueType(ir, { objectType: "Post", property: "attachments" })).toEqual(
            o.attachment({})
        );
    });

    it("throws when the object type is missing", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
        };

        expect(() => getTargetValueType(ir, { objectType: "Post", property: "attachments" })).toThrow(
            'Unknown object type "Post".'
        );
    });

    it("throws when the property is missing", () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Post",
                    displayName: "Post",
                    pluralDisplayName: "Posts",
                    primaryKey: "id",
                    properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
                },
            ],
            linkTypes: [],
            actionTypes: [],
        };

        expect(() => getTargetValueType(ir, { objectType: "Post", property: "attachments" })).toThrow(
            'Unknown property "attachments" on "Post".'
        );
    });
});
