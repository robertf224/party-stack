import { Users } from "@osdk/foundry.admin";
import { decodeFoundryUserProfilePictureAttachment } from "./foundryUser.js";
import { loadUserSubset } from "./loadUserSubset.js";
import type { FoundryUsersIntegration } from "../adapter/createFoundryOntologyBackendAdapter.js";
import type { Lens } from "@party-stack/ontology";

export function createFoundryUsersIntegration(options: {
    objectType: string;
    lens: Lens;
}): FoundryUsersIntegration {
    return {
        objectType: options.objectType,
        loadSubset: (client, query, signal) => loadUserSubset(client, options.lens, query, signal),
        async getAttachmentContent(client, attachment) {
            const userId = decodeFoundryUserProfilePictureAttachment(attachment.id);
            if (!userId) return;
            const profilePicture = await Users.profilePicture(client, userId);
            if (profilePicture.status === 204) {
                return new Blob();
            }
            return profilePicture.blob();
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
