import {
    BrowserAuthenticationCancelledError,
    type BrowserAuthentication,
    type BrowserAuthenticationSession,
} from "@party-stack/runtime";

function matchesRedirectUrl(
    candidate: string,
    redirectUrl: string
): boolean {
    const actual = new URL(candidate);
    const expected = new URL(redirectUrl);
    return (
        actual.origin === expected.origin &&
        actual.pathname === expected.pathname
    );
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

export function createWebBrowserAuthentication(options: {
    popupTarget?: string;
    popupFeatures?: string;
} = {}): BrowserAuthentication {
    return {
        start({ redirectUrl, presentation }) {
            if (presentation !== "popup") {
                return createRedirectSession();
            }
            const popup = window.open(
                "about:blank",
                options.popupTarget ??
                    "party-stack-authentication",
                options.popupFeatures ??
                    "popup=yes,width=500,height=700"
            );
            if (!popup) return createRedirectSession();

            let stopWaiting:
                | (() => void)
                | undefined;
            let cancel:
                | (() => void)
                | undefined;
            return {
                open(authorizationUrl) {
                    popup.location.assign(
                        authorizationUrl
                    );
                    return new Promise<{
                        callbackUrl: string;
                    }>(
                        (resolve, reject) => {
                            cancel = () => {
                                stopWaiting?.();
                                cancel = undefined;
                                reject(
                                    new BrowserAuthenticationCancelledError()
                                );
                            };
                            const timer = window.setInterval(
                                () => {
                                    if (popup.closed) {
                                        cancel?.();
                                        return;
                                    }
                                    try {
                                        const current =
                                            popup.location.href;
                                        if (
                                            !matchesRedirectUrl(
                                                current,
                                                redirectUrl
                                            )
                                        ) {
                                            return;
                                        }
                                        stopWaiting?.();
                                        cancel =
                                            undefined;
                                        popup.close();
                                        resolve({
                                            callbackUrl:
                                                current,
                                        });
                                    } catch {
                                        // Cross-origin access is expected until the provider returns.
                                    }
                                },
                                250
                            );
                            stopWaiting = () => {
                                window.clearInterval(
                                    timer
                                );
                                stopWaiting =
                                    undefined;
                            };
                        }
                    );
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
