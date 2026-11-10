import { collectionOptions, DbClient, eq } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { StrictMode, Suspense, use, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OntologyProvider, useAttachmentUrl, useOntology } from "../src/index.js";
import { OwnedValue } from "../src/resource.js";
import type { LiveOntology } from "@party-stack/ontology";

const params = new URL(location.href).searchParams;
const state = {
    providerFallbacks: 0,
    attachmentFallbacks: 0,
    borrowedCloses: 0,
    ownedOpened: [] as number[],
    ownedClosed: [] as number[],
    reads: [] as { owner: string; signal: AbortSignal; resolve(value: Blob): void }[],
    created: [] as string[],
    revoked: [] as string[],
};
const createUrl = URL.createObjectURL.bind(URL);
const revokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
    const url = createUrl(blob);
    state.created.push(url);
    return url;
};
URL.revokeObjectURL = (url) => {
    state.revoked.push(url);
    revokeUrl(url);
};
const dbClient = new DbClient();
const items = collectionOptions({
    id: "borrowed-provider-ready",
    getKey: (row: { id: string; title: string }) => row.id,
    sync: {
        sync: ({ begin, write, commit, markReady }) => {
            begin();
            write({ type: "insert", value: { id: "one", title: "Preloaded" } });
            void commit();
            markReady();
        },
    },
});
const query = {
    query: (q: import("@tanstack/db").InitialQueryBuilder) =>
        q
            .from({ item: items })
            .where(({ item }) => eq(item.id, "one"))
            .select(({ item }) => ({ title: item.title }))
            .findOne(),
};
await dbClient.preloadLiveQuery(query);

const views = ["first", "second"].map(
    (owner) =>
        ({
            dbClient,
            context: { owner },
            attachments: {
                blob: (_value: unknown, options: { signal: AbortSignal }) =>
                    new Promise<Blob>((resolve) =>
                        state.reads.push({ owner, signal: options.signal, resolve })
                    ),
            },
            cleanup: async () => {
                state.borrowedCloses++;
            },
        }) as unknown as LiveOntology
);
function Fallback({ attachment = false }: { attachment?: boolean }) {
    useLayoutEffect(() => {
        if (attachment) state.attachmentFallbacks++;
        else state.providerFallbacks++;
    }, [attachment]);
    return <span data-testid={attachment ? "attachment-pending" : "provider-pending"}>Pending</span>;
}
function ReadyQuery() {
    const { data } = useLiveSuspenseQuery(query);
    const ontology = useOntology();
    return (
        <span data-testid="ready">
            {String(ontology.context.owner)}: {data?.title}
        </span>
    );
}
function Attachment() {
    const url = useAttachmentUrl({ id: "sample" });
    return <span data-testid="url">{url}</span>;
}
function BorrowedCase() {
    const [selected, setSelected] = useState(0);
    const [attachment, setAttachment] = useState(false);
    return (
        <>
            <button onClick={() => setSelected(1)}>Replace view</button>
            <button onClick={() => setAttachment(true)}>Read attachment</button>
            <Suspense fallback={<Fallback />}>
                <OntologyProvider ontology={views[selected]!}>
                    <ReadyQuery />
                    {attachment && (
                        <Suspense fallback={<Fallback attachment />}>
                            <Attachment />
                        </Suspense>
                    )}
                </OntologyProvider>
            </Suspense>
        </>
    );
}
const factories = [0, 1].map((id) => () => {
    state.ownedOpened.push(id);
    return {
        id,
        cleanup: () => {
            state.ownedClosed.push(id);
        },
    };
});
const never = new Promise<void>(() => {});
function Never() {
    use(never);
    return null;
}
function OwnedCase() {
    const [selected, setSelected] = useState(0);
    return (
        <>
            <button onClick={() => setSelected(1)}>Replace value</button>
            <Suspense fallback={<Fallback />}>
                <OwnedValue open={factories[selected]!}>
                    {(value) => <span data-testid="value">{value.id}</span>}
                </OwnedValue>
                {params.has("abandoned") && <Never />}
            </Suspense>
        </>
    );
}
const root = createRoot(document.getElementById("root")!);
const app = params.has("owned") ? <OwnedCase /> : <BorrowedCase />;
root.render(params.has("strict") ? <StrictMode>{app}</StrictMode> : app);
Reflect.set(window, "borrowedFixture", {
    state: () => ({
        ...state,
        reads: state.reads.map(({ owner, signal }) => ({ owner, aborted: signal.aborted })),
    }),
    resolve: (index: number) => state.reads[index]!.resolve(new Blob(["attachment"])),
    close: () => root.unmount(),
});
