import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import styles from "../styles.css?url";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "Party Stack — Connected data. Local interaction." },
            {
                name: "description",
                content:
                    "An ontology-aware TypeScript stack for local data, optimistic actions, and connected backends. Built with Effect.",
            },
        ],
        links: [{ rel: "stylesheet", href: styles }],
    }),
    component: Root,
    notFoundComponent: () => (
        <main className="missing-page">
            <p className="eyebrow">404</p>
            <h1>Nothing here yet.</h1>
            <Link to="/docs/$" params={{ _splat: undefined }}>
                Back to the docs →
            </Link>
        </main>
    ),
});

function Root() {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <HeadContent />
            </head>
            <body>
                <RootProvider>
                    <Outlet />
                </RootProvider>
                <Scripts />
            </body>
        </html>
    );
}
