import { o, type Lens } from "@party-stack/ontology";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { eq, field } from "@party-stack/ontology-storage";
import { byteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeFoundryOntologyBackend } from "../adapter/makeFoundryOntologyBackend.js";
import { createFoundryUsersIntegration } from "./createFoundryUsersIntegration.js";
import { foundryUserProfilePictureAttachment } from "./foundryUser.js";
import { createFoundryUserObjectType } from "./foundryUser.js";
import type { OntologyClient } from "@party-stack/foundry-client";

const mocks = vi.hoisted(() => ({
    profilePicture: vi.fn(),
    getBatch: vi.fn(),
    search: vi.fn(),
    list: vi.fn(),
}));

vi.mock("@osdk/foundry.admin", () => ({
    Users: {
        profilePicture: mocks.profilePicture,
        getBatch: mocks.getBatch,
        search: mocks.search,
        list: mocks.list,
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
    it("loads the signed-in user by ID through the native backend instead of an unfiltered collection", async () => {
        const lens = {
            operations: [
                o.LensOp.move({ from: ["profilePicture"], to: ["avatar"] }),
                o.LensOp.select({ properties: ["id", "givenName", "familyName", "email", "avatar"] }),
            ],
        } satisfies Lens;
        const user = {
            id: "user-1",
            username: "robert",
            givenName: "Robert",
            familyName: "Fidler",
            email: "robert@example.com",
        };
        mocks.search.mockResolvedValue({ data: [] });
        mocks.list.mockResolvedValue({ data: [user] });
        mocks.getBatch.mockResolvedValue({ data: { [user.id]: user } });
        const adapter = makeFoundryOntologyBackend({
            client: {
                baseUrl: "https://foundry.example",
                ontologyRid: "ontology",
                fetch: vi.fn(),
            } as unknown as OntologyClient,
            ir: {
                types: [],
                objectTypes: [createFoundryUserObjectType("User", lens)],
                actionTypes: [],
                linkTypes: [],
                queryFunctionTypes: [],
            },
            users: createFoundryUsersIntegration({ objectType: "User", lens }),
            watch: false,
        });
        const snapshot = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* adapter;
                    return yield* backend.loadSubset(
                        objectSubset("User", { where: eq(field("id"), "user-1") })
                    );
                })
            )
        );
        expect(snapshot.rows).toMatchObject([
            {
                key: "user-1",
                value: {
                    id: "user-1",
                    givenName: "Robert",
                    familyName: "Fidler",
                    email: "robert@example.com",
                    avatar: { id: expect.stringContaining("foundry-user-profile:") },
                },
            },
        ]);
        expect(mocks.getBatch).toHaveBeenCalledWith(expect.anything(), [{ userId: "user-1" }]);
        expect(mocks.search).not.toHaveBeenCalled();
    });
    it("represents a missing profile picture as an empty blob", async () => {
        mocks.profilePicture.mockResolvedValue(
            new Response(null, {
                status: 204,
            })
        );
        const integration = createFoundryUsersIntegration({
            objectType: "User",
            lens: identityLens,
        });

        await expect(
            integration.getAttachmentContent!(
                {} as never,
                foundryUserProfilePictureAttachment("user-1")
            ).then((blob) => blob?.size)
        ).resolves.toBe(0);
    });
});

it("returns profile-picture bytes as a stream without buffering the response", async () => {
    const response = new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
            },
        }),
        { headers: { "Content-Type": "image/png" } }
    );
    const buffer = vi.spyOn(response, "blob");
    mocks.profilePicture.mockResolvedValue(response);
    const integration = createFoundryUsersIntegration({ objectType: "User", lens: identityLens });
    const source = await integration.getAttachmentContent!(
        {} as never,
        foundryUserProfilePictureAttachment("user-1")
    );
    expect(source).not.toBeInstanceOf(Blob);
    expect(source?.type).toBe("image/png");
    expect(buffer).not.toHaveBeenCalled();
    const head = await Effect.runPromise(Stream.runHead(byteSource(source!).stream));
    expect(head).toMatchObject({ _tag: "Some", value: new Uint8Array([1, 2, 3]) });
});
