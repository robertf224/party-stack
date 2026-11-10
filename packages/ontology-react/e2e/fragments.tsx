import { BasicIndex, DbClient, eq, localOnlyCollectionOptions } from "@tanstack/db";
import { DbProvider, useLiveSuspenseQuery } from "@tanstack/react-db";
import { Suspense, startTransition, useState } from "react";
import { createRoot } from "react-dom/client";
import { defineFragment, ontologyCollections, useFragment, type FragmentRef } from "../src/index.js";

type Item = { id: string; title: string; body: string };
const { objects } = ontologyCollections<{
    objectTypes: { Item: Item };
    actionTypes: {};
    queryFunctionTypes: {};
}>({ Item: "id" });
const client = new DbClient({
    "@party-stack/ontology/collectionOptions": (id: string) =>
        localOnlyCollectionOptions<Item>({
            id,
            getKey: (row) => row.id,
            autoIndex: "eager",
            defaultIndexType: BasicIndex,
            initialData: [
                { id: "one", title: "One", body: "private" },
                { id: "two", title: "Two", body: "other" },
            ],
        }),
});
const items = client.collection(objects.Item);

const titleFragment = defineFragment(objects.Item, (row, { prefix = "" } = {}) => ({
    title: row.title,
    prefix,
}));
function Title({ item }: { item: FragmentRef<typeof titleFragment> }) {
    const { data: value } = useFragment(item);
    return <span data-testid="title">{value ? value.prefix + value.title : ""}</span>;
}

const fragment = defineFragment(objects.Item, (row, { prefix = "" } = {}) => ({
    title: titleFragment.include(row, { prefix }),
}));
let renders = 0;
function Card({ item }: { item: FragmentRef<typeof fragment> }) {
    const { data: value } = useFragment(item);
    renders++;
    return value ? <Title item={value.title} /> : null;
}
function List({ selected, prefix }: { selected: string; prefix: string }) {
    const { data } = useLiveSuspenseQuery((q) =>
        q
            .from({ item: objects.Item })
            .where(({ item }) => eq(item.id, selected))
            .select(({ item }) => ({ id: item.id, card: fragment.include(item, { prefix }) }))
    );
    return data.map((row) => <Card key={row.id} item={row.card} />);
}
function App() {
    const [visible, show] = useState(true);
    const [selected, select] = useState("one");
    const [prefix, setPrefix] = useState("");
    return (
        <>
            <button
                onClick={() =>
                    void items.update("one", (draft) => {
                        draft.body = "changed";
                    })
                }
            >
                Body
            </button>
            <button
                onClick={() =>
                    void items.update("one", (draft) => {
                        draft.title = "Updated";
                    })
                }
            >
                Title
            </button>
            <button onClick={() => show(!visible)}>Toggle</button>
            <button onClick={() => startTransition(() => setPrefix((value) => (value ? "" : "Prefix: ")))}>
                Arguments
            </button>
            <button
                onClick={() => startTransition(() => select((value) => (value === "one" ? "two" : "one")))}
            >
                Switch
            </button>
            <Suspense fallback={<span>Loading</span>}>
                {visible && <List key={selected} selected={selected} prefix={prefix} />}
            </Suspense>
        </>
    );
}
createRoot(document.getElementById("root")!).render(
    <DbProvider client={client}>
        <App />
    </DbProvider>
);
Reflect.set(window, "fragmentFixture", { renders: () => renders });
