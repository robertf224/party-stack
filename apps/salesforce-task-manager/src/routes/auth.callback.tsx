import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { completeSalesforceOAuthRedirect } from "../app/salesforce";

export const Route = createFileRoute("/auth/callback")({ ssr: false, component: OAuthCallback });

function OAuthCallback() {
    const navigate = useNavigate();
    const [error, setError] = useState<string>();

    useEffect(() => {
        void completeSalesforceOAuthRedirect(window.location.href).then(
            () => navigate({ to: "/" }),
            (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
        );
    }, [navigate]);

    return <main className="loading">{error ?? "Completing Salesforce sign-in…"}</main>;
}
