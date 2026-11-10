import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { SiteHeader } from "../components/site-layout";
import styles from "../styles.css?url";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "Party Stack — Enjoy the party." },
            {
                name: "description",
                content:
                    "Live queries, offline sync, optimistic actions, files, authentication, and authorization. A TypeScript framework built with Effect.",
            },
        ],
        links: [
            { rel: "icon", href: "/favicon.svg?v=mirror-dot-e", type: "image/svg+xml" },
            { rel: "stylesheet", href: styles },
        ],
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
                <RootProvider
                    theme={{
                        defaultTheme: "system",
                        enableSystem: true,
                        storageKey: "party-stack-theme",
                        hotKey: false,
                    }}
                >
                    <div className="site-shell">
                        <SiteHeader />
                        <div className="site-content">
                            <Outlet />
                        </div>
                    </div>
                </RootProvider>
                <Scripts />
            </body>
        </html>
    );
}
