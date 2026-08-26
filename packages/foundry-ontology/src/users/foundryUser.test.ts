import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    decodeFoundryUserProfilePictureAttachment,
    foundryUserObjectType,
    foundryUserProfilePictureAttachment,
} from "./foundryUser.js";

describe("Foundry user", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

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
        vi.spyOn(
            Date,
            "now"
        ).mockReturnValue(
            123 * 60 * 60 * 1_000
        );
        expect(foundryUserProfilePictureAttachment("user/1")).toEqual({
            id: "foundry-user-profile:user%2F1:123",
        });
        expect(
            decodeFoundryUserProfilePictureAttachment(
                "foundry-user-profile:user%2F1:123"
            )
        ).toBe("user/1");
        expect(
            decodeFoundryUserProfilePictureAttachment(
                "foundry-user-profile:user%2F1"
            )
        ).toBe("user/1");
    });

    it("rotates the profile picture attachment ID hourly", () => {
        const now = vi.spyOn(
            Date,
            "now"
        );
        now.mockReturnValue(
            10 * 60 * 60 * 1_000
        );
        const first =
            foundryUserProfilePictureAttachment(
                "user-1"
            );
        now.mockReturnValue(
            11 * 60 * 60 * 1_000
        );
        const second =
            foundryUserProfilePictureAttachment(
                "user-1"
            );

        expect(first.id).not.toBe(
            second.id
        );
    });
});
