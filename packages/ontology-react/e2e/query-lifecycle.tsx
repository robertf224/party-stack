import {
    collectionOptions,
    DbClient,
    eq,
    type DehydratedDbState,
    type InitialQueryBuilder,
} from "@tanstack/db";
import { DbProvider, useLiveSuspenseQuery } from "@tanstack/react-db";
import { Component, Suspense, useState, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

const metrics = { starts: 0, loads: 0, releases: 0, renders: 0 };
let publish!: (title: string) => void;
const rows = collectionOptions({
    id: "query-lifecycle-items",
    getKey: (row: { id: string; title: string }) => row.id,
    syncMode: "on-demand",
    sync: {
        sync: ({ begin, write, commit, markReady, fail }) => {
            metrics.starts++;
            begin();
            write({ type: "insert", value: { id: "one", title: "First" } });
            write({ type: "insert", value: { id: "two", title: "Second" } });
            void commit();
            markReady();
            publish = (title) => {
                begin();
                write({ type: "update", value: { id: "one", title } });
                void commit();
            };
            return {
                loadSubset: () => {
                    metrics.loads++;
                    if (typeof window !== "undefined" && location.search.includes("fail")) {
                        const error = new Error("Fixture access denied");
                        // A permission denial stops this sync run, matching
                        // the ontology adapter's fatal-demand failure path.
                        fail(error);
                        return Promise.reject(error);
                    }
                    return true;
                },
                unloadSubset: () => {
                    metrics.releases++;
                },
            };
        },
    },
});
const selection = (id: string) => ({
    // Exercise initial-error retry ownership even when a committed query's
    // inactive retention is explicitly short. Other modes use the native default.
    gcTime: typeof location !== "undefined" && location.search.includes("short-retention") ? 1 : undefined,
    query: (q: InitialQueryBuilder) => {
        const query = q
            .from({ row: rows })
            .where(({ row }) => eq(row.id, id))
            .select(({ row }) => ({ title: row.title }));
        return typeof location !== "undefined" && location.search.includes("unbounded")
            ? query
            : query.findOne();
    },
});
function Detail({ id }: { id: string }) {
    metrics.renders++;
    const { data } = useLiveSuspenseQuery(selection(id));
    const item = Array.isArray(data) ? data[0] : data;
    return <output data-testid="title">{item?.title}</output>;
}
class Boundary extends Component<{ children: ReactNode }, { error?: string }> {
    state: { error?: string } = {};
    static getDerivedStateFromError(error: Error) {
        return { error: error.message };
    }
    render() {
        return this.state.error ? (
            <output data-testid="error">{this.state.error}</output>
        ) : (
            this.props.children
        );
    }
}
function App({ client }: { client: DbClient }) {
    const [id, setId] = useState("one");
    return (
        <DbProvider client={client}>
            <Boundary>
                <button onClick={() => setId((id) => (id === "one" ? "two" : "one"))}>Select other</button>
                <Suspense fallback={<output data-testid="pending">Pending</output>}>
                    <Detail id={id} />
                </Suspense>
            </Boundary>
        </DbProvider>
    );
}
export async function serverFixture() {
    const { renderToString } = await import("react-dom/server");
    const client = new DbClient();
    try {
        await client.preloadLiveQuery(selection("one"));
        return { html: renderToString(<App client={client} />), state: client.dehydrate() };
    } finally {
        await client.cleanup();
    }
}
if (typeof document !== "undefined") {
    const initial = Reflect.get(window, "queryInitial") as
        | { html: string; state: DehydratedDbState }
        | undefined;
    const container = document.getElementById("root")!;
    const client = new DbClient();
    if (initial) {
        client.hydrate(initial.state);
        container.innerHTML = initial.html;
    }
    const errors: string[] = [];
    const options = {
        onRecoverableError: (error: unknown) => errors.push(String(error)),
        onCaughtError: () => {},
    };
    const root = initial
        ? hydrateRoot(container, <App client={client} />, options)
        : createRoot(container, options);
    if (!initial) root.render(<App client={client} />);
    Reflect.set(window, "queryFixture", {
        metrics,
        errors,
        publish: (title: string) => publish(title),
        snapshot: () => ({
            metrics,
            status: client.collection(rows).status,
            health: client.collection(rows).health,
        }),
        close: async () => {
            root.unmount();
            await client.cleanup();
        },
    });
}
