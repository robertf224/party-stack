import type { CloudKitHttpTokenProvider } from "./index.js";
import type { CloudKitError } from "@party-stack/cloudkit-client";

export interface BrowserCloudKitAuth {
    tokenProvider: CloudKitHttpTokenProvider;
    captureTokenFromUrl(url?: string | URL): boolean;
    clear(): void;
    hasToken(): boolean;
}

export interface CreateBrowserCloudKitAuthOptions {
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    storageKey?: string;
    onAuthenticationRequired?: (
        redirectURL?: string
    ) => void | Promise<void>;
}

export function createBrowserCloudKitAuth(
    options: CreateBrowserCloudKitAuthOptions = {}
): BrowserCloudKitAuth {
    const storage =
        options.storage ??
        (typeof window === "undefined"
            ? undefined
            : window.localStorage);
    const storageKey =
        options.storageKey ?? "party-stack.cloudkit.web-auth-token";
    let memoryToken: string | undefined;

    const getToken = () =>
        storage?.getItem(storageKey) ?? memoryToken;
    const setToken = (token: string) => {
        memoryToken = token;
        storage?.setItem(storageKey, token);
    };

    return {
        tokenProvider: {
            getWebAuthToken: () =>
                Promise.resolve(getToken() ?? undefined),
            handleAuthenticationRequired: async (
                error: CloudKitError
            ) => {
                const details =
                    typeof error.details === "object" &&
                    error.details !== null
                        ? (error.details as Record<
                              string,
                              unknown
                          >)
                        : undefined;
                const redirectURL =
                    typeof details?.redirectURL === "string"
                        ? details.redirectURL
                        : typeof details?.redirectUrl === "string"
                          ? details.redirectUrl
                          : undefined;
                await options.onAuthenticationRequired?.(
                    redirectURL
                );
            },
        },
        captureTokenFromUrl(url = window.location.href) {
            const parsed =
                url instanceof URL ? url : new URL(url);
            const token =
                parsed.searchParams.get("ckWebAuthToken") ??
                parsed.searchParams.get("ckSession");
            if (!token) return false;
            setToken(token);
            return true;
        },
        clear() {
            memoryToken = undefined;
            storage?.removeItem(storageKey);
        },
        hasToken: () => Boolean(getToken()),
    };
}
