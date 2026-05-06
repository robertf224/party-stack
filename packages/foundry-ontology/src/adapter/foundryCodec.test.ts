import { o } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import { createFoundryCodec } from "./foundryCodec.js";

describe("createFoundryCodec", () => {
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
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
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
            })
        ).toEqual({
            id: "doc-1",
            file: {
                id: "ri.attachments.main.attachment.1",
            },
        });
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
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
        });

        expect(
            codec.decodeObject("Document", {
                id: "doc-1",
                file: {
                    reference: {
                        type: "mediaSetViewItem",
                        mediaSetViewItem: {
                            mediaItemRid: "ri.mio.main.media-item.1",
                            mediaSetRid: "ri.mio.main.media-set.1",
                            mediaSetViewRid: "ri.mio.main.view.1",
                        },
                    },
                    mimeType: "image/png",
                },
            })
        ).toEqual({
            id: "doc-1",
            file: {
                id: "ri.mio.main.media-item.1",
                type: "image/png",
            },
        });
    });
});
