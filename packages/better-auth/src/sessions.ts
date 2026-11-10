import { ConnectError } from "@party-stack/connect";
import { Effect, Option, Schema } from "effect";

export interface BetterAuthSessionClient {
    readonly multiSession: {
        listDeviceSessions(): Promise<{
            readonly data?:
                | readonly {
                      readonly session: {
                          readonly id: string;
                          readonly token: string;
                          readonly expiresAt: Date;
                      };
                      readonly user: { readonly id: string; readonly name?: string | null };
                  }[]
                | null;
            readonly error?: unknown;
        }>;
        revoke(input: { readonly sessionToken: string }): Promise<{ readonly error?: unknown }>;
    };
}

const httpError = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }));

export function betterAuthError(error: unknown, message: string): ConnectError {
    const status = Option.getOrUndefined(httpError(error))?.status;
    return new ConnectError({
        kind: status === 401 ? "NeedsAuthentication" : status === 403 ? "Forbidden" : "Provider",
        retryable: status === undefined || status === 408 || status === 429 || status >= 500,
        message,
    });
}

export const listBetterAuthSessions = Effect.fnUntraced(function* (client: BetterAuthSessionClient) {
    const result = yield* Effect.tryPromise({
        try: () => client.multiSession.listDeviceSessions(),
        catch: (error) => betterAuthError(error, "Better Auth sessions are unavailable."),
    });
    if (result.error) return yield* betterAuthError(result.error, "Could not read Better Auth sessions.");
    return result.data ?? [];
});
