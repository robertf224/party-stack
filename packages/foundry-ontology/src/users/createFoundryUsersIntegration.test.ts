import {
    o,
    type Lens,
} from "@party-stack/ontology";
import {
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { createFoundryUsersIntegration } from "./createFoundryUsersIntegration.js";
import { foundryUserProfilePictureAttachment } from "./foundryUser.js";

const mocks = vi.hoisted(() => ({
    profilePicture: vi.fn(),
}));

vi.mock("@osdk/foundry.admin", () => ({
    Users: {
        profilePicture:
            mocks.profilePicture,
    },
}));

const identityLens = {
    operations: [
        o.LensOp.select({
            properties: ["id"],
        }),
    ],
} satisfies Lens;

describe("createFoundryUsersIntegration", () => {
    it("represents a missing profile picture as an empty blob", async () => {
        mocks.profilePicture.mockResolvedValue(
            new Response(null, {
                status: 204,
            })
        );
        const integration =
            createFoundryUsersIntegration({
                objectType: "User",
                lens: identityLens,
            });

        await expect(
            integration.getAttachmentContent!(
                {} as never,
                foundryUserProfilePictureAttachment(
                    "user-1"
                )
            ).then((blob) => blob?.size)
        ).resolves.toBe(0);
    });
});
