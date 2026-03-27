/// <reference types="vite/client" />
import { useState, useEffect, type ReactNode } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts, Link, useRouterState } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { OntologyProvider, useOntology } from "../ontology/OntologyProvider";
import { CommandBar } from "../components/CommandBar";
import "../app.css";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "Ontology Explorer" },
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

function ClientGate({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    if (!ready) return <>{fallback ?? null}</>;
    return <>{children}</>;
}

function RootComponent() {
    return (
        <RootDocument>
            <ClientGate
                fallback={
                    <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-500">
                        Loading...
                    </div>
                }
            >
                <OntologyProvider>
                    <div className="flex h-screen bg-zinc-950 text-zinc-100">
                        <Sidebar />
                        <main className="flex-1 overflow-auto">
                            <Outlet />
                        </main>
                    </div>
                    <CommandBar />
                </OntologyProvider>
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
            <body className="h-full antialiased">
                {children}
                <Scripts />
            </body>
        </html>
    );
}

function Sidebar() {
    const { meta } = useOntology();
    const routerState = useRouterState();
    const currentPath = routerState.location.pathname;

    const { data: objectTypes } = useLiveQuery(
        (q) =>
            q
                .from({ ot: meta.objects.ObjectType })
                .select(({ ot }) => ({
                    name: ot.name,
                    displayName: ot.displayName,
                }))
                .orderBy(({ ot }) => ot.displayName, "asc"),
        [],
    );

    const { data: linkTypes } = useLiveQuery(
        (q) =>
            q
                .from({ lt: meta.objects.LinkType })
                .select(({ lt }) => ({
                    id: lt.id,
                }))
                .orderBy(({ lt }) => lt.id, "asc"),
        [],
    );

    return (
        <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-4">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold">
                    O
                </div>
                <Link to="/" className="text-sm font-semibold text-zinc-100">
                    Ontology Explorer
                </Link>
            </div>

            <nav className="flex-1 overflow-y-auto p-3">
                <NavLink to="/" label="Dashboard" active={currentPath === "/"} />

                <NavSection title="Object Types" count={objectTypes.length}>
                    {objectTypes.map((ot) => (
                        <NavLink
                            key={ot.name}
                            to={`/object-types/${ot.name}`}
                            label={ot.displayName}
                            active={currentPath === `/object-types/${ot.name}`}
                        />
                    ))}
                </NavSection>

                <NavSection title="Link Types" count={linkTypes.length}>
                    {linkTypes.map((lt) => (
                        <NavLink
                            key={lt.id as string}
                            to={`/link-types/${encodeURIComponent(lt.id as string)}`}
                            label={lt.id as string}
                            active={currentPath === `/link-types/${encodeURIComponent(lt.id as string)}`}
                        />
                    ))}
                </NavSection>
            </nav>

            <div className="border-t border-zinc-800 px-4 py-3">
                <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-300"
                    onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
                >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                    </svg>
                    Search...
                    <kbd className="ml-auto rounded border border-zinc-600 bg-zinc-700 px-1 py-0.5 text-[10px]">
                        ⌘K
                    </kbd>
                </button>
            </div>
        </aside>
    );
}

function NavSection({
    title,
    count,
    children,
}: {
    title: string;
    count: number;
    children: ReactNode;
}) {
    return (
        <div className="mt-5">
            <div className="mb-1 flex items-center justify-between px-2">
                <span className="text-[11px] font-medium tracking-wider text-zinc-500 uppercase">{title}</span>
                <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{count}</span>
            </div>
            <div className="flex flex-col gap-0.5">{children}</div>
        </div>
    );
}

function NavLink({ to, label, active }: { to: string; label: string; active: boolean }) {
    return (
        <Link
            to={to}
            className={`block truncate rounded-md px-2 py-1.5 text-sm transition-colors ${
                active ? "bg-zinc-800 font-medium text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
            }`}
        >
            {label}
        </Link>
    );
}
