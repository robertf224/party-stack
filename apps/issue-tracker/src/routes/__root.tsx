/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { type ReactNode } from "react";
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
    notFoundComponent: () => (
        <main className="p-8 text-center">
            <h1 className="text-xl font-semibold">Page not found</h1>
            <Link to="/" className="mt-4 inline-block underline">
                Back to Issue Tracker
            </Link>
        </main>
    ),
});

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
                {children}
                <Scripts />
            </body>
        </html>
    );
}
