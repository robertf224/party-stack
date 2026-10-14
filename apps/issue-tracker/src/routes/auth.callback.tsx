import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { completeFoundryOAuthRedirect } from "../app/profiles";

export const Route = createFileRoute("/auth/callback")({
    component: FoundryOAuthCallback,
});

function FoundryOAuthCallback() {
    const navigate = useNavigate();
    const [error, setError] = useState<string>();

    useEffect(() => {
        if (window.opener) return;
        void completeFoundryOAuthRedirect(window.location.href)
            .then(() =>
                navigate({
                    to: "/",
                    replace: true,
                })
            )
            .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
            });
    }, [navigate]);

    return (
        <main className="grid min-h-screen place-items-center bg-slate-950 text-white">
            <div className="text-center">
                {!error && (
                    <span className="mx-auto block size-5 animate-spin rounded-full border-2 border-slate-600 border-r-indigo-400" />
                )}
                <p className="mt-3 text-sm text-slate-300">{error ?? "Finishing Foundry sign in…"}</p>
            </div>
        </main>
    );
}
