import { BrowserAuthenticationError, type BrowserAuthentication } from "@party-stack/runtime";
import { Effect } from "effect";
import { dismissAuthSession, openAuthSessionAsync } from "expo-web-browser";

export function createExpoBrowserAuthentication(): BrowserAuthentication {
    return {
        start: Effect.fnUntraced(function* ({ redirectUrl }) {
            let used = false;
            let closed = false;
            const dismiss = () => {
                if (closed) return;
                closed = true;
                if (used) dismissAuthSession();
            };
            yield* Effect.addFinalizer(() => Effect.sync(dismiss));
            return {
                open: (authorizationUrl: string) =>
                    Effect.gen(function* () {
                        if (used || closed)
                            return yield* new BrowserAuthenticationError({
                                reason: "Configuration",
                                message: "This authentication session has already been used or closed.",
                            });
                        used = true;
                        const result = yield* Effect.tryPromise({
                            try: () => openAuthSessionAsync(authorizationUrl, redirectUrl),
                            catch: (cause) =>
                                new BrowserAuthenticationError({
                                    reason: "Platform",
                                    message: "Could not open browser authorization.",
                                    cause,
                                }),
                        });
                        if (result.type === "success") return { callbackUrl: result.url };
                        return yield* new BrowserAuthenticationError({
                            reason: "Cancelled",
                            message: "Browser authentication was cancelled.",
                        });
                    }).pipe(Effect.onInterrupt(() => Effect.sync(dismiss))),
            };
        }),
    };
}
