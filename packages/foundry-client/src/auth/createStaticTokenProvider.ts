import type { TokenProvider } from "./TokenProvider.js";

export interface CreateStaticTokenProviderOptions {
    token: string | (() => string | Promise<string>);
}

/**
 * Returns a {@link TokenProvider} that always resolves to the given bearer token.
 * Accepts either a static string or a sync/async resolver.
 */
export function createStaticTokenProvider(opts: CreateStaticTokenProviderOptions): TokenProvider {
    return async () => {
        const token = typeof opts.token === "function" ? await opts.token() : opts.token;
        if (typeof token !== "string" || token.length === 0) {
            throw new Error("Static token provider resolved to an empty token.");
        }
        return token;
    };
}
