import {
    BrowserAuthenticationCancelledError,
    type BrowserAuthentication,
} from "@party-stack/runtime";
import {
    dismissAuthSession,
    openAuthSessionAsync,
} from "expo-web-browser";

export function createExpoBrowserAuthentication(): BrowserAuthentication {
    return {
        start({ redirectUrl }) {
            return {
                async open(authorizationUrl) {
                    const result =
                        await openAuthSessionAsync(
                            authorizationUrl,
                            redirectUrl
                        );
                    if (result.type === "success") {
                        return {
                            callbackUrl: result.url,
                        };
                    }
                    throw new BrowserAuthenticationCancelledError();
                },
                close() {
                    dismissAuthSession();
                },
            };
        },
    };
}
