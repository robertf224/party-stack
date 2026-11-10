import {
    BasicIndex,
    DbClient,
    type Collection,
    type CollectionConfig,
    type NonSingleResult,
} from "@tanstack/db";
import { DbProvider, useLiveSuspenseQuery } from "@tanstack/react-db";
import { Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { defineFragment, ontologyCollections, useFragment, type FragmentRef } from "../src/index.js";

type Item = { id: string; title: string };
const { objects } = ontologyCollections<{
    objectTypes: { Item: Item };
    actionTypes: {};
    queryFunctionTypes: {};
}>({ Item: "id" });
const metrics = { starts: 0, loads: 0, releases: 0 };
let reportError!: (error: unknown) => void;
let reportHealthy!: () => void;
const client = new DbClient({
    "@party-stack/ontology/collectionOptions": (id: string): CollectionConfig<Item> => ({
        id,
        getKey: (row) => row.id,
        autoIndex: "eager",
        defaultIndexType: BasicIndex,
        syncMode: "on-demand",
        sync: {
            sync: (sync) => {
                metrics.starts++;
                sync.begin();
                sync.write({ type: "insert", value: { id: "one", title: "One" } });
                void sync.commit();
                sync.markReady();
                reportError = sync.reportError;
                reportHealthy = sync.reportHealthy;
                return {
                    loadSubset: () => {
                        metrics.loads++;
                        return true;
                    },
                    unloadSubset: () => {
                        metrics.releases++;
                    },
                };
            },
        },
    }),
});
const fragment = defineFragment(objects.Item, (item) => ({ title: item.title }));
function Health({ item }: { item: FragmentRef<typeof fragment> }) {
    const { health } = useLiveSuspenseQuery(
        item as unknown as Collection<{ title: string }> & NonSingleResult
    );
    return <output data-testid="health">{health?.hasErrors ? "problem" : "healthy"}</output>;
}
function Card({ item, showHealth }: { item: FragmentRef<typeof fragment>; showHealth: boolean }) {
    const { data: value } = useFragment(item);
    return (
        <>
            <output data-testid="title">{value?.title}</output>
            {showHealth && <Health item={item} />}
        </>
    );
}
function Inventory({ showHealth }: { showHealth: boolean }) {
    const { data } = useLiveSuspenseQuery((q) =>
        q.from({ item: objects.Item }).select(({ item }) => ({
            id: item.id,
            detail: fragment.include(item),
        }))
    );
    return data.map((row) => <Card key={row.id} item={row.detail} showHealth={showHealth} />);
}
function App() {
    const [showHealth, setShowHealth] = useState(false);
    return (
        <DbProvider client={client}>
            <button onClick={() => setShowHealth((value) => !value)}>Toggle health</button>
            <button onClick={() => reportError(new Error("Temporary network failure"))}>Fail sync</button>
            <button onClick={() => reportHealthy()}>Recover sync</button>
            <Suspense fallback={<output data-testid="pending">Pending</output>}>
                <Inventory showHealth={showHealth} />
            </Suspense>
        </DbProvider>
    );
}
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
Reflect.set(window, "fragmentHealthFixture", {
    metrics,
    sourceHealth: () => client.collection(objects.Item).health,
    close: async () => {
        root.unmount();
        await client.cleanup();
    },
});
