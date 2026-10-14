import type { MediaItemRid, MediaReference, MediaSetRid, MediaSetViewRid } from "@osdk/foundry.core";

export interface FoundryMediaId {
    mediaSetRid: MediaSetRid;
    mediaSetViewRid: MediaSetViewRid;
    mediaItemRid: MediaItemRid;
}

function hasRidType(value: string, type: "media-set" | "view" | "media-item"): boolean {
    return value.startsWith("ri.mio.") && value.includes(`.${type}.`);
}

export function encodeFoundryMediaId(value: FoundryMediaId): string {
    const parts: string[] = [value.mediaSetRid, value.mediaSetViewRid, value.mediaItemRid];
    return parts.join(":");
}

export function decodeFoundryMediaId(value: string): FoundryMediaId | undefined {
    const parts = value.split(":");
    if (parts.length !== 3) return;
    const [mediaSetRid, mediaSetViewRid, mediaItemRid] = parts;
    if (
        !mediaSetRid ||
        !mediaSetViewRid ||
        !mediaItemRid ||
        !hasRidType(mediaSetRid, "media-set") ||
        !hasRidType(mediaSetViewRid, "view") ||
        !hasRidType(mediaItemRid, "media-item")
    ) {
        return;
    }
    return {
        mediaSetRid,
        mediaSetViewRid,
        mediaItemRid,
    };
}

export function mediaReferenceToFoundryMediaId(value: MediaReference): string {
    return encodeFoundryMediaId(value.reference.mediaSetViewItem);
}

export function foundryMediaIdToReference(id: FoundryMediaId, mimeType: string): MediaReference {
    return {
        mimeType,
        reference: {
            type: "mediaSetViewItem",
            mediaSetViewItem: id,
        },
    };
}
