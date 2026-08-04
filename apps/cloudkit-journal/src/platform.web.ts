import {
    createBrowserCloudKitAuth,
} from "@party-stack/cloudkit-client-http/browser-auth";
import { createCloudKitHttpClient } from "@party-stack/cloudkit-client-http";
import { createWebRuntime } from "@party-stack/web-runtime";
import type { JournalPlatformServices } from "./platform";

export async function createJournalPlatformServices(): Promise<JournalPlatformServices> {
    const containerIdentifier =
        process.env.EXPO_PUBLIC_CLOUDKIT_CONTAINER_ID;
    const apiToken =
        process.env.EXPO_PUBLIC_CLOUDKIT_API_TOKEN;
    if (!containerIdentifier || !apiToken) {
        throw new Error(
            "Web CloudKit requires EXPO_PUBLIC_CLOUDKIT_CONTAINER_ID and EXPO_PUBLIC_CLOUDKIT_API_TOKEN."
        );
    }
    let authenticationURL: string | undefined;
    const auth = createBrowserCloudKitAuth({
        onAuthenticationRequired: (redirectURL) => {
            authenticationURL = redirectURL;
        },
    });
    auth.captureTokenFromUrl();
    const client = createCloudKitHttpClient({
        containerIdentifier,
        environment:
            process.env.EXPO_PUBLIC_CLOUDKIT_ENVIRONMENT ===
            "production"
                ? "production"
                : "development",
        apiToken,
        tokenProvider: auth.tokenProvider,
    });
    return {
        client,
        runtime: createWebRuntime,
        accountStatus: await client.getAccountStatus(),
        platformDescription: "CloudKit Web Services",
        signIn: () => {
            if (!authenticationURL) {
                throw new Error(
                    "CloudKit did not return an authentication URL. Check the API token callback and allowed-origin settings."
                );
            }
            window.location.assign(authenticationURL);
        },
    };
}
