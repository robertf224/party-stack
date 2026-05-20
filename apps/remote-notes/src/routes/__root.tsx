/// <reference types="vite/client" />
import { useEffect, useState, type ReactNode } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import "../app.css";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "Remote Notes" },
        ],
        links: [
            { rel: "preconnect", href: "https://fonts.googleapis.com" },
            { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
            {
                rel: "stylesheet",
                href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
            },
        ],
    }),
    component: RootComponent,
});

function ClientGate({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    if (!ready) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
                Loading remote notes...
            </div>
        );
    }
    return <>{children}</>;
}

function RootComponent() {
    return (
        <RootDocument>
            <ClientGate>
                <Outlet />
            </ClientGate>
        </RootDocument>
    );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body className="min-h-screen bg-slate-950 antialiased">
                {children}
                <Scripts />
            </body>
        </html>
    );
}
