import {
    BasicIndex,
    createCollection,
    localOnlyCollectionOptions,
    Query,
    eq,
    gt,
    DbClient,
} from "@tanstack/db";
import { DbProvider, useLiveSuspenseQuery, useLiveInfiniteQuery } from "@tanstack/react-db";
import { Suspense, startTransition, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
    defineFragment,
    defineListFragment,
    useListFragment,
    useFragment,
    type FragmentRef,
    type ListFragmentRef,
} from "../src/index.js";
import type { NonSingleResult } from "@tanstack/db";

const rows = Array.from({ length: 5 }, (_, i) => ({
    id: String(i + 1),
    folder: "a",
    title: `Item ${i + 1}`,
}));
let release = () => {};
let orderedPending = false;
let releaseOrdered = () => {};
let orderedReleased = false;
const orderedGate = new Promise<void>((resolve) => {
    releaseOrdered = resolve;
});
const items = createCollection<{ id: string; folder: string; title: string }>({
    getKey: (row) => row.id,
    autoIndex: "eager",
    defaultIndexType: BasicIndex,
    syncMode: location.search.includes("held") ? "on-demand" : "eager",
    sync: {
        sync({ begin, write, commit, markReady }) {
            begin();
            rows.forEach((value) => write({ type: "insert", value }));
            void commit();
            release = markReady;
            return {
                loadSubset(options) {
                    if (location.search.includes("held") && options.limit === 3 && !orderedReleased) {
                        orderedPending = true;
                        return orderedGate;
                    }
                    return Promise.resolve();
                },
            };
        },
    },
});
const folders = createCollection(
    localOnlyCollectionOptions<{ id: string }>({
        getKey: (row) => row.id,
        initialData: [{ id: "a" }],
        autoIndex: "eager",
        defaultIndexType: BasicIndex,
    })
);
const list = defineListFragment(items, (scope, { limit = 2, after = "" }) =>
    scope
        .where(({ row }) => gt(row.id, after))
        .orderBy(({ row }) => row.id)
        .limit(limit)
        .select(({ row }) => ({ title: row.title }))
);
function Child({ notes }: { notes: ListFragmentRef<typeof list> }) {
    const result = useListFragment(notes);
    const collection = result.collection;
    useEffect(() => {
        lastCollection = collection;
    }, [collection]);
    return (
        <>
            <output data-testid="rows">{result.data.map((row) => row.title).join(",")}</output>
            <output data-testid="collection">{result.collection.id}</output>
            <button
                disabled={!result.hasNextPage || result.isFetchingNextPage}
                onClick={() => void result.fetchNextPage()}
            >
                More
            </button>
        </>
    );
}
const card = defineFragment(
    folders,
    (folder, { after = "" }) => ({
        list: list.include(
            new Query().from({ row: items }).where(({ row }) => eq(row.folder, folder.id)),
            { after }
        ),
    }),
    { key: (row) => row.id }
);
function Card({ folder }: { folder: FragmentRef<typeof card> }) {
    const { data } = useFragment(folder);
    return data ? <Child notes={data.list} /> : null;
}
let parentBuilds = 0;
let fallbackMounts = 0;
let lastCollection: { readonly subscriberCount: number } | undefined;
function Included() {
    const [after, setAfter] = useState("");
    const [visible, setVisible] = useState(true);
    const { data } = useLiveSuspenseQuery((q) => {
        parentBuilds++;
        return q
            .from({ folder: folders })
            .select(({ folder }) => ({
                card: card.include(folder, { after }),
            }))
            .findOne();
    });
    return (
        <>
            {visible && <Card folder={data!.card} />}
            <button onClick={() => startTransition(() => setAfter(after ? "" : "2"))}>Filter</button>
            <button onClick={() => setVisible(!visible)}>Toggle</button>
        </>
    );
}
function Infinite() {
    const initial = useLiveSuspenseQuery((q) =>
        q
            .from({ row: items })
            .orderBy(({ row }) => row.id)
            .limit(3)
    );
    const result = useLiveInfiniteQuery(initial.collection as typeof initial.collection & NonSingleResult, {
        pageSize: 2,
    });
    return (
        <>
            <output data-testid="rows">{result.data.map((row) => row.title).join(",")}</output>
            <output data-testid="collection">{result.collection.id}</output>
            <button disabled={!result.hasNextPage} onClick={() => void result.fetchNextPage()}>
                More
            </button>
        </>
    );
}
function Pending() {
    useEffect(() => {
        fallbackMounts++;
    }, []);
    return <output data-testid="pending">Opening</output>;
}
const app = (
    <Suspense fallback={<Pending />}>
        {location.search.includes("included") ? <Included /> : <Infinite />}
    </Suspense>
);
createRoot(document.getElementById("root")!).render(
    location.search.includes("client") ? <DbProvider client={new DbClient()}>{app}</DbProvider> : app
);
Reflect.set(window, "listFixture", {
    release: () => release(),
    releaseOrdered: () => {
        orderedReleased = true;
        releaseOrdered();
    },
    metrics: () => ({
        parentBuilds,
        fallbackMounts,
        orderedPending,
        readers: lastCollection?.subscriberCount,
    }),
});
