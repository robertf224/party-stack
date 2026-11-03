import { Users } from "@osdk/foundry.admin";
import { readableByteSource } from "@party-stack/ontology-storage/blobs";
import { decodeFoundryUserProfilePictureAttachment } from "./foundryUser.js";
import { loadUserSubset } from "./loadUserSubset.js";
import type { FoundryUsersIntegration } from "../adapter/createFoundryOntologyBackendAdapter.js";
import type { Lens } from "@party-stack/ontology-spec";

export function createFoundryUsersIntegration(options: {
    objectType: string;
    lens: Lens;
}): FoundryUsersIntegration {
    return {
        objectType: options.objectType,
        loadSubset: (client, query, signal) =>
            loadUserSubset(client, options.objectType, options.lens, query, signal),
        async getAttachmentContent(client, attachment) {
            const userId = decodeFoundryUserProfilePictureAttachment(attachment.id);
            if (!userId) return;
            const profilePicture = await Users.profilePicture(client, userId);
            if (profilePicture.status === 204) {
                return new Blob();
            }
            return profilePicture.body
                ? readableByteSource(profilePicture.body, {
                      type: profilePicture.headers.get("content-type") ?? "application/octet-stream",
                  })
                : new Blob();
        },
        getAttachmentMetadata(_client, attachment) {
            const userId = decodeFoundryUserProfilePictureAttachment(attachment.id);
            return Promise.resolve(
                userId
                    ? {
                          id: attachment.id,
                          type: attachment.type,
                          name: `${userId} profile picture`,
                      }
                    : undefined
            );
        },
    };
}
