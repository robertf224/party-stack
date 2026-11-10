import { ConnectError } from "@party-stack/connect";
import { Effect, Schema } from "effect";
import { listBetterAuthSessions } from "./sessions.js";
import type { BetterAuthSessionClient } from "./sessions.js";
import type { AccountRef } from "@party-stack/connect";

const Session = Schema.Union([
    Schema.Struct({ id: Schema.NonEmptyString }),
    Schema.Struct({ token: Schema.NonEmptyString }),
]);

export interface AttachBetterAuthSessionOptions {
    readonly client: BetterAuthSessionClient;
    readonly authentication: {
        attachExternalSession(
            instanceId: string,
            sessionId: string
        ): Promise<AccountRef & { readonly kind: "external-session" }>;
    };
    readonly serviceInstanceId: string;
    /** The session or sign-in data returned by Better Auth. Never choose by user ID or recency. */
    readonly session: { readonly id: string } | { readonly token: string };
}

/** Attach the exact session returned by the application's normal Better Auth flow.
 * The credential owner still verifies the selected session before saving it.
 */
export function attachBetterAuthSession(options: AttachBetterAuthSessionOptions) {
    return Effect.runPromise(
        Effect.gen(function* () {
            const session = yield* Schema.decodeUnknownEffect(Session)(options.session).pipe(
                Effect.mapError(
                    () =>
                        new ConnectError({
                            kind: "Configuration",
                            retryable: false,
                            message: "Supply the session returned by Better Auth sign-in.",
                        })
                )
            );
            let id: string;
            if ("id" in session) id = session.id;
            else {
                const sessions = yield* listBetterAuthSessions(options.client);
                const selected = sessions.find((entry) => entry.session.token === session.token);
                if (!selected)
                    return yield* new ConnectError({
                        kind: "NeedsAuthentication",
                        retryable: false,
                        message: "The signed-in Better Auth session is unavailable.",
                    });
                id = selected.session.id;
            }
            return yield* Effect.tryPromise({
                try: () => options.authentication.attachExternalSession(options.serviceInstanceId, id),
                catch: (error) => error,
            });
        })
    );
}
