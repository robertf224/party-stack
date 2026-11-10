import {
    collectionOptions,
    BasicIndex,
    createCollection,
    createLiveQueryCollection,
    DbClient,
    localOnlyCollectionOptions,
    Query,
    prepareLiveQueryValue,
    eq,
} from "@tanstack/db";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { defineFragment, type FragmentData, type FragmentRef } from "./index.js";

const source = () =>
    createCollection(
        localOnlyCollectionOptions<{ id: string; title: string; body: string; parent?: string }>({
            getKey: (row) => row.id,
            initialData: [
                { id: "one", title: "One", body: "private", parent: "two" },
                { id: "two", title: "Two", body: "private" },
            ],
        })
    );

const byId = (items: ReturnType<typeof source>, id: unknown) =>
    new Query().from({ row: items }).where(({ row }) => eq(row.id, id as Parameters<typeof eq>[1]));

test("fragment includes isolate selected changes and survive relationship moves, deletion and reinsertion", async () => {
    const items = source();
    const badge = defineFragment(
        items,
        (row) => ({
            title: row.title,
        }),
        { key: (row) => row.id }
    );
    const row = defineFragment(
        items,
        (item) => ({
            title: item.title,
            parent: badge.include(byId(items, item.parent)),
        }),
        { key: (item) => item.id }
    );
    const query = createLiveQueryCollection({
        query: (q) =>
            q.from({ item: items }).select(({ item }) => ({ id: item.id, detail: row.include(item) })),
    });
    const sub = query.subscribeChanges(() => {});
    try {
        await query.preload();
        const one = query.toArray.find((x) => x.id === "one")!.detail;
        const assign: FragmentRef<typeof row> = one;
        expectTypeOf<FragmentData<typeof badge>["title"]>().toEqualTypeOf<string>();
        // @ts-expect-error Unselected data does not belong to the fragment.
        type Hidden = FragmentData<typeof badge>["body"];
        expectTypeOf<Hidden>().not.toBeNever();
        const changes: unknown[] = [];
        const child = one.subscribeChanges((batch) => changes.push(batch));
        await items
            .update("one", (draft) => {
                draft.body = "changed";
            })
            .when("settled");
        expect(changes).toEqual([]);
        await items
            .update("one", (draft) => {
                draft.title = "Updated";
            })
            .when("settled");
        expect(one.toArray[0]?.title).toBe("Updated");
        expect(query.toArray.find((x) => x.id === "one")!.detail).toBe(one);
        expect(one.toArray[0]?.parent.toArray[0]?.title).toBe("Two");
        await items
            .update("one", (draft) => {
                draft.parent = "missing";
            })
            .when("settled");
        expect(one.toArray[0]?.parent.size).toBe(0);
        await items
            .update("one", (draft) => {
                draft.parent = "two";
            })
            .when("settled");
        expect(one.toArray[0]?.parent.toArray[0]?.title).toBe("Two");
        await items.delete("two").when("settled");
        expect(one.toArray[0]?.parent.size).toBe(0);
        await items.insert({ id: "two", title: "Returned", body: "" }).when("settled");
        expect(one.toArray[0]?.parent.toArray[0]?.title).toBe("Returned");
        child.unsubscribe();
        void assign;
    } finally {
        sub.unsubscribe();
        await query.cleanup();
        await items.cleanup({ dependents: true });
    }
});

test("one descriptor fragment resolves independently in each DbClient", async () => {
    const descriptor = collectionOptions("items", (client) =>
        localOnlyCollectionOptions<{ id: string; title: string }>({
            id: "items",
            getKey: (row) => row.id,
            initialData: [{ id: "one", title: client.requireDependency<string>("title") }],
        })
    );
    const fragment = defineFragment(
        descriptor,
        (row) => ({
            title: row.title,
        }),
        { key: (row) => row.id }
    );
    const first = new DbClient({ title: "First" });
    const second = new DbClient({ title: "Second" });
    const queries = [first, second].map((client) => {
        const query = new Query()
            .from({ item: descriptor })
            .select(({ item }) => ({ detail: fragment.include(item) }));
        // Bind through the same native resolver as the React adapter. Live refs
        // must stay owned by a live query; queryOnce cleans its child views up.
        return createLiveQueryCollection({ query: prepareLiveQueryValue(query, client) as typeof query });
    });
    const subscriptions = queries.map((query) => query.subscribeChanges(() => {}));
    try {
        await Promise.all(queries.map((query) => query.preload()));
        expect(queries[0]?.toArray[0]?.detail.toArray[0]?.title).toBe("First");
        expect(queries[1]?.toArray[0]?.detail.toArray[0]?.title).toBe("Second");
    } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        await Promise.all(queries.map((query) => query.cleanup()));
        await first.cleanup();
        await second.cleanup();
    }
});

test("anonymous fragments correlate by the collection key rather than an id property", async () => {
    const items = createCollection(
        localOnlyCollectionOptions<{ slug: string; title: string }>({
            getKey: (row) => row.slug,
            initialData: [{ slug: "actual-key", title: "Selected" }],
        })
    );
    const title = defineFragment(items, (row) => ({ title: row.title }));
    const nested = defineFragment(items, (row) => ({ key: row.slug, child: title.include(row) }));
    const query = createLiveQueryCollection({
        query: (q) =>
            q.from({ item: items }).select(({ item }) => ({
                detail: nested.include(item),
            })),
    });
    const sub = query.subscribeChanges(() => {});
    try {
        await query.preload();
        expect(query.toArray[0]!.detail.toArray[0]!.child.toArray).toMatchObject([{ title: "Selected" }]);
        await items
            .update("actual-key", (draft) => {
                draft.title = "Updated";
            })
            .when("settled");
        expect(query.toArray[0]!.detail.toArray[0]!.child.toArray).toMatchObject([{ title: "Updated" }]);
    } finally {
        sub.unsubscribe();
        await query.cleanup();
        await items.cleanup({ dependents: true });
    }
});

test("primary-key metadata generates an indexed field correlation without a key selector", async () => {
    const items = Object.assign(
        createCollection(
            localOnlyCollectionOptions<{ slug: string; title: string }>({
                getKey: (row) => row.slug,
                autoIndex: "eager",
                defaultIndexType: BasicIndex,
                initialData: [
                    { slug: "one", title: "Selected" },
                    { slug: "two", title: "Other" },
                ],
            })
        ),
        { primaryKey: "slug" as const }
    );
    const fragment = defineFragment(items, (row) => ({ title: row.title }));
    const query = createLiveQueryCollection({
        query: (q) =>
            q
                .from({ item: items })
                .where(({ item }) => eq(item.slug, "one"))
                .select(({ item }) => ({ child: fragment.include(item) })),
    });
    const subscription = query.subscribeChanges(() => {});
    try {
        await query.preload();
        expect(query.toArray[0]!.child.toArray).toMatchObject([{ title: "Selected" }]);
        expect(items.getIndexMetadata().map((index) => index.expression)).toContainEqual({
            type: "ref",
            path: ["slug"],
        });
        expect(items.getIndexMetadata().map((index) => index.expression)).not.toContainEqual({
            type: "ref",
            path: ["$key"],
        });
    } finally {
        subscription.unsubscribe();
        await query.cleanup();
        await items.cleanup({ dependents: true });
    }
});

test("typed arguments and defaults bind independently through nested fragments", async () => {
    const items = source();
    type Args = { label: string; includeBody?: boolean; optional?: string };
    const detail = defineFragment(
        items,
        (row, { label, includeBody = false, optional = "unset" }: Args) => ({
            title: row.title,
            label,
            ...(includeBody ? { body: row.body } : {}),
            optional,
        }),
        { key: (row) => row.id }
    );
    const wrapper = defineFragment(
        items,
        (row, args: { label: string }) => ({
            child: detail.include(row, { label: args.label }),
        }),
        { key: (row) => row.id }
    );
    const query = createLiveQueryCollection({
        query: (q) =>
            q
                .from({ item: items })
                .where(({ item }) => eq(item.id, "one"))
                .select(({ item }) => ({
                    compact: wrapper.include(item, { label: "Compact" }),
                    full: detail.include(item, { label: "Full", includeBody: true, optional: "provided" }),
                    lookup: detail.include(byId(items, item.id), { label: "Lookup", includeBody: undefined }),
                })),
    });
    const subscription = query.subscribeChanges(() => {});
    try {
        await query.preload();
        const result = query.toArray[0]!;
        const compact = result.compact.toArray[0]!.child;
        const full = result.full;
        expect(compact.toArray).toMatchObject([{ title: "One", label: "Compact", optional: "unset" }]);
        expect(compact.toArray[0]).not.toHaveProperty("body");
        expect(full.toArray).toMatchObject([
            { title: "One", label: "Full", body: "private", optional: "provided" },
        ]);
        expect(result.lookup.toArray[0]).toMatchObject({ title: "One", label: "Lookup", optional: "unset" });
        expect(result.lookup.toArray[0]).not.toHaveProperty("body");
        const compactChanges: unknown[] = [];
        const listener = compact.subscribeChanges((batch) => compactChanges.push(batch));
        try {
            await items
                .update("one", (row) => {
                    row.body = "Changed body";
                })
                .when("settled");
            expect(compactChanges).toEqual([]);
            expect(full.toArray[0]?.body).toBe("Changed body");
            await items
                .update("one", (row) => {
                    row.title = "Changed title";
                })
                .when("settled");
            expect(compact.toArray[0]?.title).toBe("Changed title");
            expect(full.toArray[0]?.title).toBe("Changed title");
        } finally {
            listener.unsubscribe();
        }
    } finally {
        subscription.unsubscribe();
        await query.cleanup();
        await items.cleanup({ dependents: true });
    }

    const checkTypes = () => {
        detail.include(byId(items, "one"), { label: "valid" });
        // @ts-expect-error Required arguments cannot be omitted.
        detail.include(byId(items, "one"));
        // @ts-expect-error Optional includeBody does not make label optional.
        detail.include(byId(items, "one"), {});
        // @ts-expect-error Argument types are checked at each binding.
        detail.include(byId(items, "one"), { label: "bad", includeBody: "yes" });
        // @ts-expect-error Unknown argument names are rejected.
        detail.include(byId(items, "one"), { label: "bad", unknown: true });
        // @ts-expect-error Same-row includes also require their declared arguments.
        wrapper.include({} as Parameters<typeof wrapper.include>[0]);
        // @ts-expect-error Inline projections are not part of the fragment API.
        void detail.select;
        // @ts-expect-error Fragment inclusion has one public spelling.
        void detail.ref;
        // @ts-expect-error Key correlations use explicit queries.
        void detail.refByKey;
        expectTypeOf<FragmentData<typeof detail>["body"]>().toEqualTypeOf<string | undefined>();
    };
    void checkTypes;
});

test("optional argument sets can be omitted and use normal JavaScript defaults", async () => {
    const items = source();
    const defaulted = defineFragment(items, (row, { label = "Default" }) => ({
        title: row.title,
        label,
    }));
    const optional = defineFragment(items, (row, { query = undefined as string | undefined }) => ({
        title: row.title,
        label: query ?? "Default",
    }));
    const query = createLiveQueryCollection({
        query: (q) =>
            q.from({ item: items }).select(({ item }) => ({
                defaulted: defaulted.include(item),
                optional: optional.include(item),
            })),
    });
    const subscription = query.subscribeChanges(() => {});
    try {
        await query.preload();
        const result = query.toArray;
        expect(result?.[0]?.defaulted.toArray).toMatchObject([{ title: "One", label: "Default" }]);
        expect(result?.[0]?.optional.toArray).toMatchObject([{ title: "One", label: "Default" }]);
        // Also type-check omitted argument sets for the include methods.
        const checkTypes = () => {
            defaulted.include(byId(items, "one"));
            defaulted.include(byId(items, "one"), { label: "Custom" });
            // @ts-expect-error The argument type is inferred from the default value.
            defaulted.include(byId(items, "one"), { label: 123 });
            // @ts-expect-error Inference does not widen to arbitrary arguments.
            defaulted.include(byId(items, "one"), { unknown: true });
            optional.include(byId(items, "one"));
            optional.include(byId(items, "one"), { query: "Search" });
            // @ts-expect-error Optional defaults retain their declared inner type.
            optional.include(byId(items, "one"), { query: 123 });
            expectTypeOf<FragmentData<typeof defaulted>["label"]>().toEqualTypeOf<string>();
            // @ts-expect-error Selected result types stay inferred with explicit Args.
            type Hidden = FragmentData<typeof optional>["body"];
            expectTypeOf<Hidden>().not.toBeNever();
        };
        void checkTypes;
    } finally {
        subscription.unsubscribe();
        await query.cleanup();
        await items.cleanup({ dependents: true });
    }
});
