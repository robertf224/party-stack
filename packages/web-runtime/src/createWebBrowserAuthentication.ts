import {
    BrowserAuthenticationCancelledError,
    type BrowserAuthentication,
    type BrowserAuthenticationSession,
} from "@party-stack/runtime";
import { Schema } from "effect";

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

function createRedirectSession(): BrowserAuthenticationSession {
    return {
        open(authorizationUrl) {
            location.assign(authorizationUrl);
            return new Promise(() => undefined);
        },
        close() {
            window.stop();
        },
    };
}

export function createWebBrowserAuthentication(
    options: {
        popupTarget?: string;
        popupFeatures?: string;
    } = {}
): BrowserAuthentication {
    return {
        start({ redirectUrl, presentation }) {
            if (presentation !== "popup") {
                return createRedirectSession();
            }
            const popup = window.open(
                "about:blank",
                options.popupTarget ?? "party-stack-authentication",
                options.popupFeatures ?? "popup=yes,width=500,height=700"
            );
            if (!popup) return createRedirectSession();

            let stopWaiting: (() => void) | undefined;
            let cancel: (() => void) | undefined;
            return {
                open(authorizationUrl) {
                    const expected = new URL(redirectUrl);
                    const state = new URL(authorizationUrl).searchParams.get("state");
                    return new Promise<{
                        callbackUrl: string;
                    }>((resolve, reject) => {
                        cancel = () => {
                            stopWaiting?.();
                            cancel = undefined;
                            reject(new BrowserAuthenticationCancelledError());
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
                                        { type: "party-stack:browser-authentication:accepted", state },
                                        expected.origin
                                    );
                                } catch {
                                    /* The opener can still complete if the popup cannot acknowledge. */
                                }
                                stopWaiting?.();
                                cancel = undefined;
                                resolve({ callbackUrl: candidate });
                                popup.close();
                            } catch {
                                /* Ignore unrelated or malformed messages. */
                            }
                        };
                        const message = (event: MessageEvent<unknown>) => {
                            if (
                                event.origin !== expected.origin ||
                                event.source !== popup ||
                                !isCallbackMessage(event.data)
                            )
                                return;
                            accept(event.data.callbackUrl);
                        };
                        window.addEventListener("message", message);
                        const timer = window.setInterval(() => {
                            if (popup.closed) {
                                cancel?.();
                                return;
                            }
                            try {
                                accept(popup.location.href);
                            } catch {
                                /* Cross-origin reads can remain blocked in embedded browsers. */
                            }
                        }, 250);
                        stopWaiting = () => {
                            window.clearInterval(timer);
                            window.removeEventListener("message", message);
                            stopWaiting = undefined;
                        };
                        try {
                            popup.location.assign(authorizationUrl);
                        } catch (cause) {
                            stopWaiting?.();
                            cancel = undefined;
                            reject(cause);
                        }
                    });
                },
                close() {
                    stopWaiting?.();
                    popup.close();
                    cancel?.();
                },
            };
        },
    };
}
