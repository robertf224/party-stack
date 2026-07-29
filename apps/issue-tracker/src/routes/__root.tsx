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
                content:
                    "width=device-width, initial-scale=1",
            },
            { title: "Issue Tracker" },
            {
                name: "description",
                content:
                    "Party Stack ontology issue tracker",
            },
        ],
    }),
    component: RootComponent,
});

function ClientGate({
    children,
}: {
    children: ReactNode;
}) {
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);

    if (!ready) {
        return (
            <main className="flex min-h-screen items-center justify-center">
                Loading issue tracker...
            </main>
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
