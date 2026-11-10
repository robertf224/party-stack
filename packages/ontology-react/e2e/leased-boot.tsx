import { BasicIndex, collectionOptions, DbClient, eq, Query } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { StrictMode, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
// Use the built helper alongside ontology-react's built db-fragments exports.
// Mixing src and lib would create separate instances of the list metadata registry.
import { prepareQuery, prepareListQuery } from "../../db-fragments/lib/prepare.js";
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
const pageSize = params.has("page50") ? 50 : 2;
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
    sameCollection: true,
    handoffs: [] as string[],
    queryGraphs: 0,
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
const dbClient = new DbClient();
const preferences = dbClient.collection(source<Preference>("preferences", [{ id: "device", width: 240 }]));
const notebooks = dbClient.collection(source<Notebook>("notebooks", [{ id: "a", name: "Notes" }]));
const notes = dbClient.collection(
    source<Note>(
        "notes",
        Array.from({ length: pageSize * 2 + 1 }, (_, n) => ({
            id: String(n + 1),
            notebookId: "a",
            rank: n,
            title: `Note ${n + 1}`,
        }))
    )
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
type RetainedQuery = {
    ready: Promise<void>;
    release(): void;
    cleanup(options?: { dependents?: boolean }): Promise<void>;
};
function prepareQueries() {
    const preference = prepareQuery(dbClient, preferenceQuery.query);
    const notebook = prepareQuery(dbClient, notebookQuery.query);
    const rootNotes = nested ? undefined : prepareListQuery(dbClient, rootList);
    const all: [string, RetainedQuery][] = [
        ["preferences", preference],
        ["notebooks", notebook],
    ];
    if (rootNotes) all.push(["notes", rootNotes]);
    stats.queryGraphs = all.length;
    const leases = new Map(all);
    return {
        preference: preference.collection,
        notebook: notebook.collection,
        rootNotes: rootNotes?.collection,
        ready: Promise.all(all.map(([, query]) => query.ready)),
        handoff(name: string) {
            const subscription = leases.get(name);
            if (!subscription) return;
            subscription.release();
            leases.delete(name);
            stats.handoffs.push(name);
        },
        async cleanup() {
            for (const subscription of leases.values()) subscription.release();
            leases.clear();
            await Promise.all(all.map(([, query]) => query.cleanup()));
        },
    };
}
type Prepared = ReturnType<typeof prepareQueries>;
function openOwner() {
    let disposed = false;
    let acquired: LiveOntology | undefined;
    let prepared: Prepared | undefined;
    let closing: Promise<void> | undefined;
    const dispose = (view: LiveOntology) =>
        (closing ??= view.cleanup().then(() => {
            stats.closed++;
        }));
    const ready = (async () => {
        await acquisition.promise;
        stats.acquired++;
        acquired = {
            dbClient,
            cleanup: async () => {
                await prepared?.cleanup();
                await dbClient.cleanup();
            },
        } as LiveOntology;
        if (disposed) {
            await dispose(acquired);
            throw new Error("Acquisition abandoned");
        }
        try {
            prepared = prepareQueries();
            await prepared.ready;
            if (disposed) {
                await dispose(acquired);
                throw new Error("Acquisition abandoned");
            }
            stats.preloadedLoads = stats.loads.length;
            stats.ready = true;
            return { view: acquired, prepared };
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
        statuses: () =>
            prepared
                ? [
                      prepared.preference.status,
                      prepared.notebook.status,
                      ...(prepared.rootNotes ? [prepared.rootNotes.status] : []),
                  ]
                : [],
        close: async () => {
            disposed = true;
            if (acquired) await dispose(acquired);
            else
                await ready.then(
                    ({ view }) => dispose(view),
                    () => {}
                );
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
type ListRow = import("../src/index.js").FragmentData<typeof list>;
function Rows({
    data,
    fetchNextPage,
    hasNextPage,
    pending,
}: {
    data: ListRow[];
    fetchNextPage(): Promise<unknown>;
    hasNextPage: boolean;
    pending: boolean;
}) {
    useLayoutEffect(() => {
        if (data.length) stats.firstRowsAt ??= performance.now();
    }, [data]);
    return (
        <div>
            <output data-testid="ids">{data.map((row) => row.id).join(",")}</output>
            {data.map((row) => (
                <Preview key={row.id} note={row.preview} />
            ))}
            <button disabled={!hasNextPage || pending} onClick={() => void fetchNextPage()}>
                More
            </button>
        </div>
    );
}
function RootNotes({ prepared }: { prepared: Prepared }) {
    const source = prepared.rootNotes!;
    const pages = useListFragment(source);
    stats.sameCollection &&= pages.collection === source;
    // Native store subscription effects are declared by these hooks first.
    // Drop only the temporary boot lease after the consumer commits.
    useEffect(() => prepared.handoff("notes"), [prepared]);
    return (
        <Rows
            data={pages.data}
            fetchNextPage={pages.fetchNextPage}
            hasNextPage={pages.hasNextPage}
            pending={pages.isFetchingNextPage}
        />
    );
}
type IsNever<Value> = [Value] extends [never] ? true : false;
// Compiled fixture assertions also cover the published declaration boundary.
function TypecheckListReaders({
    source,
    child,
    query,
    chooseRoot,
}: {
    source: NonNullable<Prepared["rootNotes"]>;
    child: ListFragmentRef<typeof list>;
    query: ReturnType<typeof rootList>;
    chooseRoot: boolean;
}) {
    const root = useListFragment(source);
    const included = useListFragment(child);
    const union = useListFragment(chooseRoot ? source : child);
    const queryOrRoot = useListFragment(chooseRoot ? source : query);
    const rowsAreNotNever: [
        IsNever<(typeof root.data)[number]>,
        IsNever<(typeof included.data)[number]>,
        IsNever<(typeof union.data)[number]>,
        IsNever<(typeof queryOrRoot.data)[number]>,
    ] = [false, false, false, false];
    const ids: string[] = [
        root.data[0]!.id,
        included.data[0]!.id,
        union.data[0]!.id,
        queryOrRoot.data[0]!.id,
    ];
    // @ts-expect-error Inferred list results retain their selection.
    void union.data[0]!.rank;
    void rowsAreNotNever;
    void ids;
    return null;
}
void TypecheckListReaders;
function NestedNotes({ input }: { input: ListFragmentRef<typeof list> }) {
    const result = useListFragment(input);
    return (
        <Rows
            data={result.data}
            fetchNextPage={result.fetchNextPage}
            hasNextPage={result.hasNextPage}
            pending={result.isFetchingNextPage}
        />
    );
}
function Folder({ reference }: { reference: FragmentRef<typeof folder> }) {
    const { data } = useFragment(reference);
    return data ? <NestedNotes input={data.notes} /> : null;
}
function Notebook({ prepared, children }: { prepared: Prepared; children?: ReactNode }) {
    const result = useLiveSuspenseQuery(prepared.notebook);
    const data = result.data!;
    const { data: title } = useFragment(data.title);
    stats.sameCollection &&= result.collection === prepared.notebook;
    useEffect(() => prepared.handoff("notebooks"), [prepared]);
    return (
        <>
            <h1>{title?.name}</h1>
            {nested && data.content ? <Folder reference={data.content} /> : children}
        </>
    );
}
function Preferences({ prepared, children }: { prepared: Prepared; children: ReactNode }) {
    const result = useLiveSuspenseQuery(prepared.preference);
    stats.sameCollection &&= result.collection === prepared.preference;
    useEffect(() => prepared.handoff("preferences"), [prepared]);
    return (
        <div data-testid="width">
            {result.data?.width}
            {children}
        </div>
    );
}
function App({ view, prepared }: { view: LiveOntology; prepared: Prepared }) {
    const [version, render] = useState(0);
    useLayoutEffect(() => {
        stats.renders++;
    });
    return (
        <Suspense fallback={<ProviderPending />}>
            <OntologyProvider ontology={view}>
                <button onClick={() => render(version + 1)}>Rerender {version}</button>
                <Suspense fallback={<Pending />}>
                    <Preferences prepared={prepared}>
                        <Notebook prepared={prepared}>
                            <RootNotes prepared={prepared} />
                        </Notebook>
                    </Preferences>
                </Suspense>
            </OntologyProvider>
        </Suspense>
    );
}
Reflect.set(window, "leasedBootFixture", {
    state: () => ({ ...stats, queryStatuses: owner.statuses() }),
    releaseAcquisition: acquisition.release,
    rejectAcquisition: () => acquisition.reject(new Error("Fixture acquisition failed")),
    release: (name: keyof typeof gates) => gates[name].release(),
    reject: (name: keyof typeof gates) => gates[name].reject(new Error("Fixture preload failed")),
    mount: async () => {
        const { view, prepared } = await owner.ready;
        stats.mountedAt = performance.now();
        root.render(
            <StrictMode>
                <App view={view} prepared={prepared} />
            </StrictMode>
        );
    },
    publish: (title: string) => publishTitle(title),
    unmount: () => root.unmount(),
    close: () => {
        root.unmount();
        void owner.close();
    },
});
if (!params.has("held-acquisition")) acquisition.release();
