/// <reference types="vite/client" />
import {
    ClientOnly,
    createRootRoute,
    HeadContent,
    Outlet,
    Scripts,
    useRouterState,
    type ErrorComponentProps,
} from "@tanstack/react-router";
import { Suspense, type ReactNode } from "react";
import { BootBoundary } from "../notes/BootBoundary";
import "../app.css";
import "../notes/controls.css";
export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "Notes" },
        ],
        links: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    }),
    component: Root,
    errorComponent: ErrorPage,
});
function Document({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                {children}
                <Scripts />
            </body>
        </html>
    );
}
function Root() {
    return (
        <Document>
            <BootBoundary>
                <ClientOnly fallback={null}>
                    <Suspense fallback={null}>
                        <InitialWorkspace />
                    </Suspense>
                </ClientOnly>
            </BootBoundary>
        </Document>
    );
}
function InitialWorkspace() {
    // Hydrated client-only matches start pending. Wait for Router's first
    // match commit so a finished parent cannot clear the Promise still read
    // by its old pending hydration snapshot. Later navigations stay mounted.
    const committed = useRouterState({ select: (state) => state.loadedAt !== 0 });
    return committed ? <Outlet /> : null;
}
function ErrorPage({ error }: ErrorComponentProps) {
    return (
        <Document>
            <main className="startup-error">
                <h1>Couldn’t open Notes</h1>
                <p>{error.message}</p>
                <button onClick={() => location.reload()}>Try again</button>
            </main>
        </Document>
    );
}
