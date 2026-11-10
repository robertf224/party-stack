import { createLiveOntology } from "@party-stack/ontology";
import {
    collectionOptions,
    createCollection,
    DbClient,
    eq,
    type CollectionConfig,
    type InitialQueryBuilder,
} from "@tanstack/db";
import { DbProvider, useLiveSuspenseQuery } from "@tanstack/react-db";
import { Effect } from "effect";
import { StrictMode, Suspense, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { executeAction } from "../../ontology-backend/lib/actions.js";
import { makeOwnedBackend } from "../../ontology-backend/lib/owned.js";
import { o, type OntologyIR } from "../../ontology-spec/lib/index.js";
import * as Memory from "../../ontology-storage/lib/memory/tables.js";

type Item = { id: string; title: string; group: string };
type Definition = {
    objectTypes: { Item: Item };
    actionTypes: { put: { parameters: Item } };
    queryFunctionTypes: {};
};
const params = new URLSearchParams(location.search);
const native = params.has("native");
const onDemand = params.has("ondemand");
const withClient = native || onDemand || params.has("client");
const metrics = { loads: 0, releases: 0 };
let blocked = params.has("async");
const pending: (() => void)[] = [];
const initialData = Array.from({ length: 20 }, (_, id) => ({
    id: String(id),
    title: `Item ${id}`,
    group: "a",
}));
const config = (): CollectionConfig<Item, string> => ({
    id: "items",
    getKey: (row) => row.id,
    syncMode: onDemand ? "on-demand" : "eager",
    sync: {
        sync: ({ begin, write, commit, markReady }) => {
            begin();
            for (const value of initialData) write({ type: "insert", value });
            void commit();
            markReady();
            return {
                loadSubset: (subset) => {
                    metrics.loads++;
                    // Only the detail request waits; the inventory remains ready.
                    return blocked &&
                        subset.where?.type === "func" &&
                        JSON.stringify(subset.where).includes('"id"')
                        ? new Promise<void>((resolve) => pending.push(resolve))
                        : true;
                },
                unloadSubset: () => {
                    metrics.releases++;
                },
            };
        },
    },
});
const descriptor = collectionOptions("items", config);
const client = new DbClient();
const property = (name: string) => ({ name, displayName: name, type: o.string({}) });
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [property("id"), property("title"), property("group")],
        },
    ],
    actionTypes: [
        {
            name: "put",
            displayName: "Put",
            parameters: [property("id"), property("title"), property("group")],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Item",
                    values: ["id", "title", "group"].map((name) => ({
                        property: [name],
                        value: o.Expression.inputReference({ name }),
                    })),
                }),
            ],
        },
    ],
};
const sdk = native
    ? await createLiveOntology<Definition>({
          ir,
          backend: Effect.gen(function* () {
              return yield* makeOwnedBackend({
                  namespace: "generic-owner",
                  ir,
                  tables: yield* Memory.make(),
                  mutators: {
                      put: (tx, request) =>
                          executeAction({ ir, tx, request }).pipe(
                              Effect.map((execution) => execution.result)
                          ),
                  },
              });
          }),
          writes: { defaultVisibility: "optimistic" },
      })
    : undefined;
const source = sdk
    ? sdk.objects.Item
    : withClient
      ? client.collection(descriptor)
      : createCollection(config());
await source.preload();
const records: {
    id: string;
    start: number;
    commit?: number;
    fallback?: number;
    source?: number;
    handler?: number;
    present?: boolean;
}[] = [];
const writes: Promise<unknown>[] = [];
const subscription = source.subscribeChanges(() => {
    const record = records.at(-1);
    if (record && source.has(record.id)) record.source ??= performance.now() - record.start;
});
const detailOptions = (id: string) => ({
    // Prompt demand-release modes deliberately choose short retention. This
    // fixture does not change or assert TanStack's default query lifetime.
    gcTime: params.has("retain") ? 60_000 : params.has("ondemand") ? 1 : undefined,
    query: (q: InitialQueryBuilder) =>
        q
            .from({ item: source })
            .where(({ item }) => eq(item.id, id))
            .select(({ item }) => ({ title: item.title }))
            .findOne(),
});
function Detail({ id }: { id: string }) {
    const input = useRef<HTMLInputElement>(null);
    const { data } = useLiveSuspenseQuery(detailOptions(id));
    useLayoutEffect(() => {
        if (!data) return;
        const record = records.at(-1)!;
        record.commit = performance.now() - record.start;
        input.current?.focus();
    }, [id, data]);
    return <input ref={input} aria-label="Item title" value={data?.title ?? ""} readOnly />;
}
function Pending() {
    useLayoutEffect(() => {
        const record = records.at(-1)!;
        record.fallback = performance.now() - record.start;
    }, []);
    return <span data-testid="detail-pending">Pending</span>;
}
function App() {
    useLiveSuspenseQuery((q) =>
        q
            .from({ item: source })
            .where(({ item }) => eq(item.group, "a"))
            .select(({ item }) => ({ id: item.id }))
    );
    const [id, setId] = useState<string>();
    return (
        <>
            <button
                onClick={() => {
                    const id = String(records.length + (native ? 20 : 0));
                    records.push({ id, start: performance.now() });
                    if (sdk) {
                        const write = sdk.actions.put({ id, title: `Item ${id}`, group: "a" });
                        writes.push(write);
                        // Keep the rejection observed until teardown awaits the
                        // writes. Faster optimistic rendering can finish first.
                        void write.catch(() => {});
                    }
                    records.at(-1)!.handler = performance.now() - records.at(-1)!.start;
                    records.at(-1)!.present = source.has(id);
                    setId(id);
                }}
            >
                Select cached row
            </button>
            {id !== undefined && (
                <Suspense key={id} fallback={<Pending />}>
                    <Detail id={id} />
                </Suspense>
            )}
        </>
    );
}
const root = createRoot(document.getElementById("root")!);
const app = (
    <Suspense fallback={<span data-testid="root-pending">Pending inventory</span>}>
        {withClient ? (
            <DbProvider client={sdk?.dbClient ?? client}>
                <App />
            </DbProvider>
        ) : (
            <App />
        )}
    </Suspense>
);
root.render(params.has("strict") ? <StrictMode>{app}</StrictMode> : app);
Reflect.set(window, "fixture", {
    records,
    metrics,
    subscribers: () => source.subscribers.length,
    release: () => {
        blocked = false;
        for (const resolve of pending.splice(0)) resolve();
    },
    close: async () => {
        await Promise.all(writes);
        root.unmount();
        subscription.unsubscribe();
        if (sdk) await sdk.cleanup();
        else if (withClient) await client.cleanup();
        else await source.cleanup();
    },
});
