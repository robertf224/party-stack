import { applyLensToObjectType, o, type Lens, type ObjectTypeDef } from "@party-stack/ontology";
import type * as v from "@party-stack/ontology/values";

export const foundryUserObjectType: ObjectTypeDef = {
    name: "FoundryUser",
    displayName: "Foundry user",
    pluralDisplayName: "Foundry users",
    primaryKey: "id",
    properties: [
        { name: "id", displayName: "ID", type: o.string({}) },
        { name: "username", displayName: "Username", type: o.string({}) },
        {
            name: "givenName",
            displayName: "Given name",
            type: o.optional({ type: o.string({}) }),
        },
        {
            name: "familyName",
            displayName: "Family name",
            type: o.optional({ type: o.string({}) }),
        },
        {
            name: "email",
            displayName: "Email",
            type: o.optional({ type: o.string({}) }),
        },
        {
            name: "profilePicture",
            displayName: "Profile picture",
            type: o.optional({
                type: o.attachment({
                    constraint: {
                        content: o.AttachmentContentConstraint.image({
                            // Accepted types shown by the "Edit profile picture" file input in Foundry settings.
                            mediaTypes: ["image/png", "image/jpeg", "image/gif", "image/svg+xml"],
                        }),
                    },
                }),
            }),
        },
    ],
};

const PROFILE_PICTURE_PREFIX = "foundry-user-profile:";
const PROFILE_PICTURE_CACHE_WINDOW_MS =
    60 * 60 * 1_000;

/**
 * Foundry exposes profile pictures through a mutable endpoint but does not
 * include presence or version metadata on User records. The hourly bucket acts
 * as a pseudo-version so BlobManager can retain its immutable-ID cache model:
 * user rows loaded in the same hour share cached content, while a later row
 * load produces a new ID and refetches the picture. Missing pictures are stored
 * as empty blobs for that bucket and retried when the ID rotates.
 */
export function foundryUserProfilePictureAttachment(userId: string): v.attachment {
    const cacheBucket = Math.floor(
        Date.now() /
            PROFILE_PICTURE_CACHE_WINDOW_MS
    );
    return {
        id: `${PROFILE_PICTURE_PREFIX}${encodeURIComponent(userId)}:${cacheBucket}`,
    };
}

export function decodeFoundryUserProfilePictureAttachment(attachmentId: string): string | undefined {
    if (
        !attachmentId.startsWith(
            PROFILE_PICTURE_PREFIX
        )
    ) {
        return;
    }
    const encoded = attachmentId.slice(
        PROFILE_PICTURE_PREFIX.length
    );
    const separator =
        encoded.lastIndexOf(":");
    if (
        separator >= 0 &&
        !/^\d+$/.test(
            encoded.slice(separator + 1)
        )
    ) {
        return;
    }
    try {
        return decodeURIComponent(
            separator < 0
                ? encoded
                : encoded.slice(
                      0,
                      separator
                  )
        );
    } catch {
        return;
    }
}

export function createFoundryUserObjectType(objectType: string, lens: Lens): ObjectTypeDef {
    return applyLensToObjectType(foundryUserObjectType, lens, {
        name: objectType,
    });
}
