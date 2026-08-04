import type { TokenProvider } from "./TokenProvider.js";

export interface CreateConfidentialTokenProviderOptions {
    foundryUrl: string;
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    fetch?: typeof globalThis.fetch;
    /** Refresh this many milliseconds before expiry. Defaults to 60_000. */
    refreshSkewMs?: number;
}

export class TokenProviderError extends Error {
    readonly status?: number;
    readonly body?: string;

    constructor(message: string, opts?: { status?: number; body?: string; cause?: unknown }) {
        super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = "TokenProviderError";
        this.status = opts?.status;
        this.body = opts?.body;
    }
}

interface TokenResponse {
    access_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
    error?: unknown;
    error_description?: unknown;
}

interface CachedToken {
    accessToken: string;
    expiresAtMs: number;
}

function joinUrl(baseUrl: string, pathname: string): string {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${normalizedBase}${normalizedPath}`;
}

function parseExpiresInSeconds(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    // Foundry tokens are typically short-lived; fall back to 5 minutes if omitted.
    return 300;
}

/**
 * OAuth2 client-credentials token provider suitable for Cloudflare Workers and Node.
 * Caches tokens, refreshes before expiry, and deduplicates concurrent refresh requests.
 */
export function createConfidentialTokenProvider(
    opts: CreateConfidentialTokenProviderOptions
): TokenProvider {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new Error("createConfidentialTokenProvider requires a fetch implementation.");
    }

    const refreshSkewMs = opts.refreshSkewMs ?? 60_000;
    const tokenUrl = joinUrl(opts.foundryUrl, "/multipass/api/oauth2/token");
    let cached: CachedToken | undefined;
    let inflight: Promise<string> | undefined;

    const acquire = async (): Promise<string> => {
        const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
        });
        if (opts.scopes && opts.scopes.length > 0) {
            body.set("scope", opts.scopes.join(" "));
        }

        let response: Response;
        try {
            response = await fetchImpl(tokenUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body,
            });
        } catch (error) {
            throw new TokenProviderError("Failed to request Foundry OAuth token.", { cause: error });
        }

        const rawBody = await response.text();
        let parsed: TokenResponse;
        try {
            parsed = rawBody.length > 0 ? (JSON.parse(rawBody) as TokenResponse) : {};
        } catch (error) {
            throw new TokenProviderError("Foundry OAuth token response was not valid JSON.", {
                status: response.status,
                body: rawBody,
                cause: error,
            });
        }

        if (!response.ok) {
            const details =
                typeof parsed.error_description === "string"
                    ? parsed.error_description
                    : typeof parsed.error === "string"
                      ? parsed.error
                      : response.statusText;
            throw new TokenProviderError(
                `Foundry OAuth token request failed with status ${response.status}: ${details}`,
                {
                    status: response.status,
                    body: rawBody,
                }
            );
        }

        if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
            throw new TokenProviderError("Foundry OAuth token response did not include access_token.", {
                status: response.status,
                body: rawBody,
            });
        }

        const expiresInSeconds = parseExpiresInSeconds(parsed.expires_in);
        cached = {
            accessToken: parsed.access_token,
            expiresAtMs: Date.now() + expiresInSeconds * 1000,
        };
        return cached.accessToken;
    };

    return async () => {
        if (cached && cached.expiresAtMs - refreshSkewMs > Date.now()) {
            return cached.accessToken;
        }

        if (!inflight) {
            inflight = acquire().finally(() => {
                inflight = undefined;
            });
        }
        return inflight;
    };
}
