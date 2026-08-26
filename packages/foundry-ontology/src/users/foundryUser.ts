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

export function foundryUserProfilePictureAttachment(userId: string): v.attachment {
    return {
        id: `${PROFILE_PICTURE_PREFIX}${encodeURIComponent(userId)}`,
    };
}

export function decodeFoundryUserProfilePictureAttachment(attachmentId: string): string | undefined {
    return attachmentId.startsWith(PROFILE_PICTURE_PREFIX)
        ? decodeURIComponent(attachmentId.slice(PROFILE_PICTURE_PREFIX.length))
        : undefined;
}

export function createFoundryUserObjectType(objectType: string, lens: Lens): ObjectTypeDef {
    return applyLensToObjectType(foundryUserObjectType, lens, {
        name: objectType,
    });
}
