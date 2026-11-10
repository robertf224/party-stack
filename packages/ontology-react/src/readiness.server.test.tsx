import { collectionOptions, DbClient, eq } from "@tanstack/db";
import { DbProvider, useLiveSuspenseQuery } from "@tanstack/react-db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

test("preloaded server query snapshots retain SSR admission and serializable data", async () => {
    const items = collectionOptions({
        id: "server-readiness",
        getKey: (row: { id: string; title: string }) => row.id,
        syncMode: "on-demand",
        sync: {
            sync: ({ begin, write, commit, markReady }) => {
                begin();
                write({ type: "insert", value: { id: "one", title: "From server" } });
                void commit();
                markReady();
                return { loadSubset: () => true };
            },
        },
    });
    const client = new DbClient();
    const query = {
        query: (q: import("@tanstack/db").InitialQueryBuilder) =>
            q
                .from({ item: items })
                .where(({ item }) => eq(item.id, "one"))
                .select(({ item }) => ({ title: item.title }))
                .findOne(),
    };
    function Detail() {
        const { data } = useLiveSuspenseQuery(query);
        return <span>{data?.title}</span>;
    }
    try {
        await client.preloadLiveQuery(query);
        expect(
            renderToStaticMarkup(
                <DbProvider client={client}>
                    <Detail />
                </DbProvider>
            )
        ).toBe("<span>From server</span>");
        expect(JSON.stringify(client.dehydrate())).toContain("From server");
    } finally {
        await client.cleanup();
    }
});
