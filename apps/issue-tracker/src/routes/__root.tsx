/// <reference types="vite/client" />
import {
    createRootRoute,
    HeadContent,
    Outlet,
    Scripts,
} from "@tanstack/react-router";
import {
    useEffect,
    useState,
    type ReactNode,
} from "react";
import "../app/globals.css";

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
});

function RootComponent() {
    return (
        <RootDocument>
            <ClientGate>
                <Outlet />
            </ClientGate>
        </RootDocument>
    );
}

function ClientGate({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);

    if (!ready) {
        return (
            <main className="grid min-h-screen place-items-center bg-slate-50">
                <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="size-3 animate-spin rounded-full border-2 border-slate-300 border-r-indigo-500" />
                    Connecting to Foundry…
                </div>
            </main>
        );
    }

    return children;
}

function RootDocument({
    children,
}: Readonly<{ children: ReactNode }>) {
    return (
        <html lang="en" className="h-full">
            <head>
                <HeadContent />
            </head>
            <body className="h-full antialiased">
                {children}
                <Scripts />
            </body>
        </html>
    );
}
