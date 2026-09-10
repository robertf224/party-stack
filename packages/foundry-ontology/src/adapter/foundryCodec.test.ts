import { o } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import { createFoundryCodec } from "./foundryCodec.js";
import { encodeFoundryMediaId } from "./foundryMediaId.js";

describe("createFoundryCodec", () => {
    it("preserves explicit nulls while leaving undefined values omitted", () => {
        const codec = createFoundryCodec({
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        });
        const optionalString = o.optional({ type: o.string({}) });

        expect(codec.encodeValue(optionalString, null)).toBeNull();
        expect(codec.encodeValue(optionalString, undefined)).toBeUndefined();
        expect(() => codec.encodeValue(o.attachment({}), {})).toThrow(
            "expected an attachment with a string id"
        );
    });

    it("decodes attachment rids into serializable pointers", () => {
        const codec = createFoundryCodec({
            types: [],
            objectTypes: [
                {
                    name: "Document",
                    displayName: "Document",
                    pluralDisplayName: "Documents",
                    primaryKey: "id",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        { name: "file", displayName: "File", type: o.attachment({}) },
                        {
                            name: "optionalFile",
                            displayName: "Optional file",
                            type: o.optional({ type: o.attachment({}) }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        });

        expect(codec.encodeValue(o.attachment({}), { id: "ri.attachments.main.attachment.1" })).toBe(
            "ri.attachments.main.attachment.1"
        );
        expect(
            codec.decodeObject("Document", {
                id: "doc-1",
                file: {
                    rid: "ri.attachments.main.attachment.1",
                },
                optionalFile: {},
            })
        ).toEqual({
            id: "doc-1",
            file: {
                id: "ri.attachments.main.attachment.1",
            },
            optionalFile: undefined,
        });
        expect(() =>
            codec.decodeObject("Document", {
                id: "doc-2",
                file: {},
            })
        ).toThrow("Invalid required Foundry attachment value");
    });

    it("decodes media references into serializable attachment pointers", () => {
        const codec = createFoundryCodec({
            types: [],
            objectTypes: [
                {
                    name: "Document",
                    displayName: "Document",
                    pluralDisplayName: "Documents",
                    primaryKey: "id",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        {
                            name: "file",
                            displayName: "File",
                            type: o.attachment({ meta: { type: "media" } }),
                        },
                        {
                            name: "optionalMedia",
                            displayName: "Optional media",
                            type: o.optional({
                                type: o.attachment({ meta: { type: "media" } }),
                            }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        });

        const reference = {
            reference: {
                type: "mediaSetViewItem" as const,
                mediaSetViewItem: {
                    mediaItemRid: "ri.mio.main.media-item.1",
                    mediaSetRid: "ri.mio.main.media-set.1",
                    mediaSetViewRid: "ri.mio.main.view.1",
                },
            },
            mimeType: "image/png",
        };
        const attachment = {
            id: encodeFoundryMediaId(reference.reference.mediaSetViewItem),
            type: "image/png",
        };

        expect(
            codec.decodeObject("Document", {
                id: "doc-1",
                file: reference,
                optionalMedia: {},
            })
        ).toEqual({
            id: "doc-1",
            file: attachment,
            optionalMedia: undefined,
        });
        expect(
            codec.encodeValue(
                o.attachment({
                    meta: { type: "media" },
                }),
                attachment
            )
        ).toEqual(reference);
    });
});
