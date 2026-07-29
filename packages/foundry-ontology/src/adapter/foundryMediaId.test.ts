import { describe, expect, it } from "vitest";
import {
    decodeFoundryMediaId,
    encodeFoundryMediaId,
    foundryMediaIdToReference,
    mediaReferenceToFoundryMediaId,
} from "./foundryMediaId.js";

const id = {
    mediaSetRid: "ri.mio.main.media-set.11111111-1111-1111-1111-111111111111",
    mediaSetViewRid: "ri.mio.main.view.22222222-2222-2222-2222-222222222222",
    mediaItemRid: "ri.mio.main.media-item.33333333-3333-3333-3333-333333333333",
};

describe("Foundry media ids", () => {
    it("round-trips the media set, view, and item rids", () => {
        const encoded = encodeFoundryMediaId(id);

        expect(decodeFoundryMediaId(encoded)).toEqual(id);
    });

    it("round-trips Foundry media references", () => {
        const reference = foundryMediaIdToReference(id, "image/png");
        reference.reference.mediaSetViewItem.token = "temporary-read-token";

        expect(mediaReferenceToFoundryMediaId(reference)).toBe(encodeFoundryMediaId(id));
    });

    it("rejects incomplete and non-media identifiers", () => {
        expect(decodeFoundryMediaId(id.mediaItemRid)).toBeUndefined();
        expect(decodeFoundryMediaId(`${id.mediaSetRid}:${id.mediaItemRid}`)).toBeUndefined();
    });
});
