import {
    BrowserAuthenticationError,
    type BrowserAuthentication,
    type BrowserAuthenticationSession,
} from "@party-stack/runtime";
import { Effect, Schema } from "effect";

const callbackMessage = Schema.Struct({
    type: Schema.Literal("party-stack:browser-authentication:callback"),
    callbackUrl: Schema.String,
});
const isCallbackMessage = Schema.is(callbackMessage);

const acceptedMessage = Schema.Struct({
    type: Schema.Literal("party-stack:browser-authentication:accepted"),
    state: Schema.NullOr(Schema.String),
});
const isAcceptedMessage = Schema.is(acceptedMessage);

/** Call on the redirect page. A different opener origin must be explicitly configured;
 * for example, a registered localhost callback returning to a named dev worktree.
 */
export function relayWebBrowserAuthenticationCallback(
    callbackUrl = window.location.href,
    options: { openerOrigin?: string; onAccepted?: () => void } = {}
): (() => void) | undefined {
    const opener = window.opener;
    if (!opener) return;
    let cleanup = () => {};
    try {
        const callback = new URL(callbackUrl);
        if (callback.origin !== window.location.origin) return;
        const openerOrigin = new URL(options.openerOrigin ?? callback.origin).origin;
        const state = callback.searchParams.get("state");
        const accepted = (event: MessageEvent<unknown>) => {
            if (
                event.origin !== openerOrigin ||
                event.source !== opener ||
                !isAcceptedMessage(event.data) ||
                event.data.state !== state
            )
                return;
            cleanup();
            options.onAccepted?.();
        };
        cleanup = () => window.removeEventListener("message", accepted);
        window.addEventListener("message", accepted);
        opener.postMessage(
            { type: "party-stack:browser-authentication:callback", callbackUrl },
            openerOrigin
        );
        return cleanup;
    } catch {
        cleanup();
        return;
    }
}

function matchesRedirectUrl(candidate: string, redirectUrl: string): boolean {
    const actual = new URL(candidate);
    const expected = new URL(redirectUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
}

/** The acquisition runs synchronously on web: reserve before any OAuth/RPC await. */
export function createWebBrowserAuthentication(
    options: { popupTarget?: string; popupFeatures?: string } = {}
): BrowserAuthentication {
    return {
        start: Effect.fnUntraced(function* ({ redirectUrl, presentation }) {
            const popup = yield* Effect.try({
                try: () => {
                    new URL(redirectUrl);
                    return presentation === "popup"
                        ? window.open(
                              "about:blank",
                              options.popupTarget ?? "party-stack-authentication",
                              options.popupFeatures ?? "popup=yes,width=500,height=700"
                          )
                        : null;
                },
                catch: (cause) =>
                    new BrowserAuthenticationError({
                        reason: "Configuration",
                        message: "Could not reserve browser authentication.",
                        cause,
                    }),
            });
            let closed = false;
            let used = false;
            let cancel: (() => void) | undefined;
            const close = () => {
                if (closed) return;
                closed = true;
                cancel?.();
                if (popup) popup.close();
                else if (used) window.stop();
            };
            yield* Effect.addFinalizer(() => Effect.sync(close));
            return {
                open: (authorizationUrl: string) =>
                    Effect.suspend(() => {
                        if (used || closed)
                            return Effect.fail(
                                new BrowserAuthenticationError({
                                    reason: "Configuration",
                                    message: "This authentication session has already been used or closed.",
                                })
                            );
                        used = true;
                        if (!popup)
                            return Effect.try({
                                try: () => location.assign(authorizationUrl),
                                catch: (cause) =>
                                    new BrowserAuthenticationError({
                                        reason: "Platform",
                                        message: "Could not open browser authorization.",
                                        cause,
                                    }),
                            }).pipe(Effect.andThen(Effect.never));
                        return Effect.callback<{ callbackUrl: string }, BrowserAuthenticationError>(
                            (resume) => {
                                const expected = new URL(redirectUrl);
                                let state: string | null;
                                try {
                                    state = new URL(authorizationUrl).searchParams.get("state");
                                } catch (cause) {
                                    resume(
                                        Effect.fail(
                                            new BrowserAuthenticationError({
                                                reason: "Configuration",
                                                message: "Invalid authorization URL.",
                                                cause,
                                            })
                                        )
                                    );
                                    return;
                                }
                                let done = false;
                                const finish = (
                                    result: Effect.Effect<{ callbackUrl: string }, BrowserAuthenticationError>
                                ) => {
                                    if (done) return;
                                    done = true;
                                    cleanup();
                                    resume(result);
                                };
                                const accept = (candidate: string) => {
                                    try {
                                        if (
                                            !matchesRedirectUrl(candidate, redirectUrl) ||
                                            new URL(candidate).searchParams.get("state") !== state
                                        )
                                            return;
                                        try {
                                            popup.postMessage?.(
                                                {
                                                    type: "party-stack:browser-authentication:accepted",
                                                    state,
                                                },
                                                expected.origin
                                            );
                                        } catch {
                                            /* The callback is already verified. */
                                        }
                                        finish(Effect.succeed({ callbackUrl: candidate }));
                                        close();
                                    } catch {
                                        /* Ignore unrelated or malformed callback messages. */
                                    }
                                };
                                const message = (event: MessageEvent<unknown>) => {
                                    if (
                                        event.origin === expected.origin &&
                                        event.source === popup &&
                                        isCallbackMessage(event.data)
                                    )
                                        accept(event.data.callbackUrl);
                                };
                                const cleanup = () => {
                                    window.clearInterval(timer);
                                    window.removeEventListener("message", message);
                                    cancel = undefined;
                                };
                                cancel = () =>
                                    finish(
                                        Effect.fail(
                                            new BrowserAuthenticationError({
                                                reason: "Cancelled",
                                                message: "Browser authentication was cancelled.",
                                            })
                                        )
                                    );
                                window.addEventListener("message", message);
                                const timer = window.setInterval(() => {
                                    if (popup.closed) {
                                        cancel?.();
                                        return;
                                    }
                                    try {
                                        accept(popup.location.href);
                                    } catch {
                                        /* A cross-origin popup is expected. */
                                    }
                                }, 250);
                                try {
                                    popup.location.assign(authorizationUrl);
                                } catch (cause) {
                                    finish(
                                        Effect.fail(
                                            new BrowserAuthenticationError({
                                                reason: "Platform",
                                                message: "Could not open browser authorization.",
                                                cause,
                                            })
                                        )
                                    );
                                }
                                return Effect.sync(cleanup);
                            }
                        ).pipe(Effect.onInterrupt(() => Effect.sync(close)));
                    }),
            } satisfies BrowserAuthenticationSession;
        }),
    };
}
