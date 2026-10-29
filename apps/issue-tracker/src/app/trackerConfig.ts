export const trackerWrites = {
    defaultMode: "outbox" as const,
    defaultVisibility: "optimistic" as const,
    outbox: { failureStrategy: "discard-all" as const },
};

function requiredEnv(name: string, value: string | undefined): string {
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

export const FOUNDRY_URL = requiredEnv("VITE_FOUNDRY_URL", import.meta.env.VITE_FOUNDRY_URL);
export const FOUNDRY_ONTOLOGY_RID = requiredEnv(
    "VITE_FOUNDRY_ONTOLOGY_RID",
    import.meta.env.VITE_FOUNDRY_ONTOLOGY_RID
);
export const FOUNDRY_CLIENT_ID = requiredEnv(
    "VITE_FOUNDRY_CLIENT_ID",
    import.meta.env.VITE_FOUNDRY_CLIENT_ID
);
export const FOUNDRY_REDIRECT_URL =
    import.meta.env.VITE_FOUNDRY_REDIRECT_URL ?? new URL("/auth/callback", globalThis.location.origin).href;

export const TRACKER_CACHE_EPOCH = "query-ir-v0";
export const FOUNDRY_INSTALLATION_ID = new URL(FOUNDRY_URL).origin;
