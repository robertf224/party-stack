import { BasicIndex, collectionOptions, DbClient, eq, Query } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { StrictMode, Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
    defineFragment,
    defineListFragment,
    OntologyProvider,
    useFragment,
    useListFragment,
    type FragmentRef,
    type ListFragmentRef,
} from "../src/index.js";
import type { LiveOntology } from "@party-stack/ontology";
import type { CollectionConfig, InitialQueryBuilder, LoadSubsetOptions } from "@tanstack/db";

type Preference = { id: string; width: number };
type Notebook = { id: string; name: string };
type Note = { id: string; notebookId: string; rank: number; title: string };
const params = new URLSearchParams(location.search);
const nested = params.has("nested");
const pageSize = 2;
const stats = {
    acquired: 0,
    closed: 0,
    starts: [] as string[],
    loads: [] as { source: string; limit?: number }[],
    releases: 0,
    releasedSources: [] as string[],
    cleanups: [] as string[],
    fallbacks: 0,
    providerFallbacks: 0,
    mountedAt: undefined as number | undefined,
    firstRowsAt: undefined as number | undefined,
    renders: 0,
    ready: false,
    failure: undefined as string | undefined,
    preloadedLoads: 0,
};
function gate() {
    let release!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
    });
    void promise.catch(() => {});
    return { promise, release, reject };
}
const acquisition = gate();
const gates = { preferences: gate(), notebooks: gate(), notes: gate() };
let publishTitle = (_title: string) => Promise.resolve();
function source<T extends { id: string }>(name: keyof typeof gates, rows: readonly T[]) {
    return collectionOptions<T>({
        id: `parallel-boot:${name}`,
        getKey: (row) => row.id,
        autoIndex: "eager",
        defaultIndexType: BasicIndex,
        syncMode: "on-demand",
        sync: {
            sync(sync) {
                stats.starts.push(name);
                let inserted = false;
                sync.markReady();
                if (name === "notes")
                    publishTitle = async (title) => {
                        sync.begin();
                        sync.write({ type: "update", value: { ...rows[0]!, title } });
                        await sync.commit();
                    };
                return {
                    loadSubset: async (options: LoadSubsetOptions) => {
                        stats.loads.push({ source: name, limit: options.limit });
                        await gates[name].promise;
                        if (!inserted) {
                            inserted = true;
                            sync.begin();
                            for (const value of rows) sync.write({ type: "insert", value });
                            await sync.commit();
                        }
                    },
                    unloadSubset: () => {
                        stats.releases++;
                        stats.releasedSources.push(name);
                    },
                    cleanup: () => {
                        stats.cleanups.push(name);
                        gates[name].reject(new Error("Source closed"));
                    },
                };
            },
        },
    } satisfies CollectionConfig<T>);
}
const preferences = source<Preference>("preferences", [{ id: "device", width: 240 }]);
const notebooks = source<Notebook>("notebooks", [{ id: "a", name: "Notes" }]);
const notes = source<Note>(
    "notes",
    Array.from({ length: 5 }, (_, n) => ({
        id: String(n + 1),
        notebookId: "a",
        rank: n,
        title: `Note ${n + 1}`,
    }))
);
const preview = defineFragment(notes, (note) => ({ title: note.title }), { key: (note) => note.id });
const list = defineListFragment(notes, (scope, { limit = pageSize }) =>
    scope
        .orderBy(({ row }) => row.rank)
        .orderBy(({ row }) => row.id)
        .limit(limit)
        .select(({ row }) => ({ id: row.id, preview: preview.include(row) }))
);
const folderTitle = defineFragment(notebooks, (folder) => ({ name: folder.name }), {
    key: (folder) => folder.id,
});
const folder = defineFragment(
    notebooks,
    (parent) => ({
        notes: list.include(
            new Query().from({ row: notes }).where(({ row }) => eq(row.notebookId, parent.id))
        ),
    }),
    { key: (parent) => parent.id }
);
const preferenceQuery = {
    gcTime: 1,
    query: (q: InitialQueryBuilder) =>
        q
            .from({ preferences })
            .where(({ preferences }) => eq(preferences.id, "device"))
            .select(({ preferences }) => ({ width: preferences.width }))
            .findOne(),
};
const notebookQuery = {
    gcTime: 1,
    query: (q: InitialQueryBuilder) =>
        q
            .from({ notebooks })
            .where(({ notebooks }) => eq(notebooks.id, "a"))
            .select(({ notebooks }) => ({
                title: folderTitle.include(notebooks),
                ...(nested ? { content: folder.include(notebooks) } : {}),
            }))
            .findOne(),
};
const rootList = () => list.query(new Query().from({ row: notes }));
// Match useListFragment's public root query window: page size plus one sentinel.
const initialListQuery = { gcTime: 1, query: () => rootList().limit(pageSize + 1) };
const bootQueries = nested
    ? [preferenceQuery, notebookQuery]
    : [preferenceQuery, notebookQuery, initialListQuery];

/** A test application owner, separate from React and the borrowed provider.
 * One acquisition Promise is a resource lifetime, not a result-row cache.
 */
function openOwner() {
    let disposed = false;
    let acquired: LiveOntology | undefined;
    let closing: Promise<void> | undefined;
    const dispose = (view: LiveOntology) =>
        (closing ??= view.cleanup().then(() => {
            stats.closed++;
        }));
    const ready = (async () => {
        await acquisition.promise;
        stats.acquired++;
        const dbClient = new DbClient();
        // The borrowed provider only requires the genuine native DbClient in
        // this fixture; acquisition/storage behavior is tested independently.
        acquired = { dbClient, cleanup: () => dbClient.cleanup() } as LiveOntology;
        if (disposed) {
            await dispose(acquired);
            throw new Error("Acquisition abandoned");
        }
        try {
            await Promise.all(bootQueries.map((query) => dbClient.preloadLiveQuery(query)));
            if (disposed) {
                await dispose(acquired);
                throw new Error("Acquisition abandoned");
            }
            stats.preloadedLoads = stats.loads.length;
            stats.ready = true;
            return acquired;
        } catch (error) {
            await dispose(acquired);
            throw error;
        }
    })();
    void ready.catch((error: unknown) => {
        stats.failure = error instanceof Error ? error.message : String(error);
    });
    return {
        ready,
        close: async () => {
            disposed = true;
            if (acquired) await dispose(acquired);
            else await ready.then(dispose, () => {});
        },
    };
}
const owner = openOwner();
const root = createRoot(document.getElementById("root")!);
function Pending() {
    useLayoutEffect(() => {
        stats.fallbacks++;
    }, []);
    return <output data-testid="pending">Pending</output>;
}
function ProviderPending() {
    useLayoutEffect(() => {
        stats.providerFallbacks++;
    }, []);
    return <output data-testid="provider-pending">Opening provider</output>;
}
function Preview({ note }: { note: FragmentRef<typeof preview> }) {
    const { data } = useFragment(note);
    return <span data-testid="preview">{data?.title}</span>;
}
function Notes({ input }: { input: ListFragmentRef<typeof list> | ReturnType<typeof rootList> }) {
    const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useListFragment(input);
    useLayoutEffect(() => {
        if (data.length) stats.firstRowsAt ??= performance.now();
    }, [data]);
    return (
        <div>
            <output data-testid="ids">{data.map((row) => row.id).join(",")}</output>
            {data.map((row) => (
                <Preview key={row.id} note={row.preview} />
            ))}
            <button disabled={!hasNextPage || isFetchingNextPage} onClick={() => void fetchNextPage()}>
                More
            </button>
        </div>
    );
}
function Folder({ reference }: { reference: FragmentRef<typeof folder> }) {
    const { data } = useFragment(reference);
    return data ? <Notes input={data.notes} /> : null;
}
function Notebook({ children }: { children?: ReactNode }) {
    const { data } = useLiveSuspenseQuery(notebookQuery);
    const { data: title } = useFragment(data!.title);
    return (
        <>
            <h1>{title?.name}</h1>
            {nested && data?.content ? <Folder reference={data.content} /> : children}
        </>
    );
}
function Preferences({ children }: { children: ReactNode }) {
    const { data } = useLiveSuspenseQuery(preferenceQuery);
    return (
        <div data-testid="width">
            {data?.width}
            {children}
        </div>
    );
}
function App({ view }: { view: LiveOntology }) {
    const [version, render] = useState(0);
    useLayoutEffect(() => {
        stats.renders++;
    });
    return (
        <Suspense fallback={<ProviderPending />}>
            <OntologyProvider ontology={view}>
                <button onClick={() => render(version + 1)}>Rerender {version}</button>
                <Suspense fallback={<Pending />}>
                    <Preferences>
                        <Notebook>
                            <Notes input={rootList()} />
                        </Notebook>
                    </Preferences>
                </Suspense>
            </OntologyProvider>
        </Suspense>
    );
}
Reflect.set(window, "parallelBootFixture", {
    state: () => ({ ...stats }),
    releaseAcquisition: acquisition.release,
    rejectAcquisition: () => acquisition.reject(new Error("Fixture acquisition failed")),
    release: (name: keyof typeof gates) => gates[name].release(),
    reject: (name: keyof typeof gates) => gates[name].reject(new Error("Fixture preload failed")),
    mount: async () => {
        const view = await owner.ready;
        stats.mountedAt = performance.now();
        root.render(
            <StrictMode>
                <App view={view} />
            </StrictMode>
        );
    },
    publish: (title: string) => publishTitle(title),
    close: () => {
        root.unmount();
        void owner.close();
    },
});
if (!params.has("held-acquisition")) acquisition.release();
