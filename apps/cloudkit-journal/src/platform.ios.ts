import { createExpoCloudKitClient } from "@party-stack/cloudkit-client-expo";
import { createExpoRuntime } from "@party-stack/expo-runtime";
import type { JournalPlatformServices } from "./platform";

export async function createJournalPlatformServices(): Promise<JournalPlatformServices> {
    const containerIdentifier =
        process.env.EXPO_PUBLIC_CLOUDKIT_CONTAINER_ID;
    if (!containerIdentifier) {
        throw new Error(
            "EXPO_PUBLIC_CLOUDKIT_CONTAINER_ID is required."
        );
    }
    const client = createExpoCloudKitClient({
        containerIdentifier,
    });
    return {
        client,
        runtime: createExpoRuntime,
        accountStatus: await client.getAccountStatus(),
        platformDescription: "Native CKDatabase",
    };
}
