import { describe, expect, it } from "vitest";
import { foundryUserObjectType, foundryUserProfilePictureAttachment } from "./foundryUser.js";

describe("Foundry user", () => {
    it("declares Foundry-supported profile picture formats", () => {
        const profilePicture = foundryUserObjectType.properties.find(
            (property) => property.name === "profilePicture"
        );

        expect(profilePicture?.type).toMatchObject({
            kind: "optional",
            value: {
                type: {
                    kind: "attachment",
                    value: {
                        constraint: {
                            content: {
                                kind: "image",
                                value: {
                                    mediaTypes: ["image/png", "image/jpeg", "image/gif", "image/svg+xml"],
                                },
                            },
                        },
                    },
                },
            },
        });
    });

    it("does not guess the profile picture media type", () => {
        expect(foundryUserProfilePictureAttachment("user/1")).toEqual({
            id: "foundry-user-profile:user%2F1",
        });
    });
});
