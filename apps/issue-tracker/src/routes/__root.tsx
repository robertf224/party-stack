/// <reference types="vite/client" />
import {
    createRootRoute,
    HeadContent,
    Link,
    Outlet,
    Scripts,
    type ErrorComponentProps,
} from "@tanstack/react-router";
import { type ReactNode } from "react";
import "../app/globals.css";
import { AppToasts } from "../components/AppToasts";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            {
                name: "viewport",
                content: "width=device-width, initial-scale=1",
            },
            { title: "Issue tracker" },
            {
                name: "description",
                content: "Live issue and project tracking",
            },
        ],
    }),
    component: RootComponent,
    errorComponent: StartupError,
    notFoundComponent: () => (
        <main className="p-8 text-center">
            <h1 className="text-xl font-semibold">Page not found</h1>
            <Link to="/" className="mt-4 inline-block underline">
                Back to Issue Tracker
            </Link>
        </main>
    ),
});

function StartupError({ error }: ErrorComponentProps) {
    const operation =
        "operation" in error && typeof error.operation === "string" ? error.operation : undefined;
    const kind = "kind" in error && typeof error.kind === "string" ? error.kind : undefined;
    return (
        <RootDocument>
            <main className="p-8">
                <h1 className="text-xl font-semibold">Could not open issue tracker</h1>
                <p className="mt-3">{error.message}</p>
                {(operation || kind) && (
                    <p className="mt-2 font-mono text-sm">{[operation, kind].filter(Boolean).join(" · ")}</p>
                )}
                <button className="mt-4 underline" onClick={() => window.location.reload()}>
                    Reload
                </button>
            </main>
        </RootDocument>
    );
}

function RootComponent() {
    return (
        <RootDocument>
            <Outlet />
        </RootDocument>
    );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
    return (
        <html lang="en" className="h-full">
            <head>
                <HeadContent />
            </head>
            <body className="h-full antialiased">
                <AppToasts>{children}</AppToasts>
                <Scripts />
            </body>
        </html>
    );
}
