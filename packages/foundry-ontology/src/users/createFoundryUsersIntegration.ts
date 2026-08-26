import { Users } from "@osdk/foundry.admin";
import type { Client } from "@party-stack/foundry-client";
import type { Lens, OntologyCollectionOptions } from "@party-stack/ontology";
import { decodeFoundryUserProfilePictureAttachment } from "./foundryUser.js";
import { userCollectionOptions } from "./userCollectionOptions.js";
import type { FoundryUsersIntegration } from "../adapter/createFoundryOntologyBackendAdapter.js";

export function createFoundryUsersIntegration(options: {
    objectType: string;
    lens: Lens;
}): FoundryUsersIntegration {
    return {
        objectType: options.objectType,
        getCollectionOptions: (client) =>
            userCollectionOptions({
                client: client as Client,
                lens: options.lens,
            }) as unknown as OntologyCollectionOptions,
        async getAttachmentContent(client, attachment) {
            const userId = decodeFoundryUserProfilePictureAttachment(attachment.id);
            if (!userId) return;
            const profilePicture = await Users.profilePicture(client, userId);
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
