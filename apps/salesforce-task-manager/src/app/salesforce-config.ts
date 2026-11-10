function requiredEnv(name: string, value: string | undefined): string {
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

function browserEnv(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const instanceUrl = requiredEnv(
    "VITE_SALESFORCE_INSTANCE_URL",
    browserEnv(import.meta.env.VITE_SALESFORCE_INSTANCE_URL)
);
export const clientId = requiredEnv(
    "VITE_SALESFORCE_CLIENT_ID",
    browserEnv(import.meta.env.VITE_SALESFORCE_CLIENT_ID)
);
export const loginUrl = browserEnv(import.meta.env.VITE_SALESFORCE_LOGIN_URL) ?? instanceUrl;
export const apiVersion = browserEnv(import.meta.env.VITE_SALESFORCE_API_VERSION) ?? "65.0";
export const redirectUrl =
    browserEnv(import.meta.env.VITE_SALESFORCE_REDIRECT_URL) ?? `${globalThis.location.origin}/auth/callback`;
export const useDevelopmentCredentials =
    import.meta.env.DEV && import.meta.env.VITE_SALESFORCE_DEV_CREDENTIALS === true;
