import { relayWebBrowserAuthenticationCallback } from "@party-stack/web-runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/auth/callback")({
    ssr: false,
    component: FoundryOAuthCallback,
});

function FoundryOAuthCallback() {
    const navigate = useNavigate();
    const [error, setError] = useState<string>();
    const [accepted, setAccepted] = useState(false);

    useEffect(() => {
        let active = true;
        let fallback: number | undefined;
        let handedOff = false;
        const openerOrigin =
            import.meta.env.DEV && import.meta.env.WORKTREE_DEV_ORIGIN
                ? String(import.meta.env.WORKTREE_DEV_ORIGIN)
                : window.location.origin;
        const finish = () => {
            if (handedOff) return;
            // The registered localhost callback has separate browser storage from the
            // worktree. Recover there only when no live opener accepted the response.
            if (openerOrigin !== window.location.origin) {
                const destination = new URL(window.location.pathname + window.location.search, openerOrigin);
                window.location.replace(destination.href);
                return;
            }
            void import("../app/profiles")
                .then(({ completeFoundryOAuthRedirect }) =>
                    completeFoundryOAuthRedirect(window.location.href)
                )
                .then((profile) => {
                    if (!active) return;
                    if (!profile)
                        throw new Error(
                            "The sign-in attempt is no longer available. Close this window and try again."
                        );
                    // If the opener reloaded during sign-in, its original popup waiter is gone.
                    // Persist the session here, then let the opener restore it on reload.
                    if (window.opener) {
                        try {
                            window.opener.location.reload();
                            window.close();
                            return;
                        } catch {
                            /* A detached opener can finish in this window. */
                        }
                    }
                    return navigate({ to: "/", replace: true });
                })
                .catch((cause: unknown) => {
                    if (active) setError(cause instanceof Error ? cause.message : String(cause));
                });
        };
        const stopRelay = relayWebBrowserAuthenticationCallback(window.location.href, {
            openerOrigin,
            onAccepted: () => {
                handedOff = true;
                if (fallback !== undefined) window.clearTimeout(fallback);
                if (active) setAccepted(true);
            },
        });
        // A live opener consumes the response and closes the popup. Otherwise recover
        // from durable PKCE state rather than leaving an inert callback page forever.
        fallback = window.setTimeout(finish, stopRelay ? 1500 : 0);
        return () => {
            active = false;
            window.clearTimeout(fallback);
            stopRelay?.();
        };
    }, [navigate]);

    return (
        <main className="grid min-h-screen place-items-center bg-slate-950 text-white">
            <div className="text-center">
                {!error && !accepted && (
                    <span className="mx-auto block size-5 animate-spin rounded-full border-2 border-slate-600 border-r-indigo-400" />
                )}
                <p className="mt-3 text-sm text-slate-300">
                    {error ?? (accepted ? "Continue in the original window." : "Finishing Foundry sign in…")}
                </p>
            </div>
        </main>
    );
}
