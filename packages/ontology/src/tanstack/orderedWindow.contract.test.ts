import {
    BasicIndex,
    compileSingleRowExpression,
    createCollection,
    createLiveQueryCollection,
    createTransaction,
    eq,
    makeComparator,
    IR,
} from "@tanstack/db";
import { expect, test } from "vite-plus/test";
import type { ChangeMessageOrDeleteKeyMessage, LoadSubsetOptions } from "@tanstack/db";

const deferred = <A>() => {
    let resolve!: (value: A | PromiseLike<A>) => void;
    const promise = new Promise<A>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
};

type Row = { id: string; favorite: boolean; rank: number | boolean; trashed: boolean };
const seed = (count = 1400): Row[] =>
    Array.from({ length: count }, (_, index) => ({
        id: String(index).padStart(4, "0"),
        favorite: false,
        rank: count - index,
        trashed: true,
    }));
const compare = (a: Row, b: Row) =>
    Number(b.favorite) - Number(a.favorite) ||
    Number(b.rank) - Number(a.rank) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const ids = (rows: readonly Row[]) => rows.map((row) => row.id);
const oracle = (rows: readonly Row[], offset = 0, limit = 51) =>
    ids(
        rows
            .filter((row) => row.trashed)
            .slice()
            .sort(compare)
            .slice(offset, offset + limit)
    );
type Call = { options: LoadSubsetOptions; count: number; active: boolean; keys: string[] };
function source(initial: Row[] = seed(), capable = true) {
    let rows = initial.slice();
    const calls: Call[] = [];
    const installed = new Set<string>();
    let publish!: (changes: ChangeMessageOrDeleteKeyMessage<Row, string>[]) => true | Promise<void>;
    let invalidate!: () => void;
    let install!: (options: LoadSubsetOptions) => true | Promise<void>;
    let fail: ((options: LoadSubsetOptions) => boolean) | undefined;
    let hold:
        | {
              predicate: (options: LoadSubsetOptions) => boolean;
              entered: ReturnType<typeof deferred<Call>>;
              released: ReturnType<typeof deferred<void>>;
          }
        | undefined;
    const selected = (options: LoadSubsetOptions) => {
        let values = rows.filter(
            (row) => !options.where || compileSingleRowExpression(options.where)(row) === true
        );
        const order =
            options.orderBy?.map((term) => ({
                extract: compileSingleRowExpression(term.expression),
                compare: makeComparator(term.compareOptions),
            })) ?? [];
        values = values.slice().sort((a, b) => {
            for (const term of order) {
                const result = term.compare(term.extract(a), term.extract(b));
                if (result) return result;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        if (options.cursor)
            values = values.filter(
                (row) =>
                    compileSingleRowExpression(options.cursor!.whereFrom)(row) === true ||
                    compileSingleRowExpression(options.cursor!.whereCurrent)(row) === true
            );
        return values.slice(
            options.offset ?? 0,
            options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit
        );
    };
    const collection = createCollection<Row>({
        id: crypto.randomUUID(),
        getKey: (row) => row.id,
        defaultStringCollation: { stringSort: "lexical" },
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
        syncMode: "on-demand",
        sync: {
            supportsOrderedWindow: (options) => {
                const final = options.orderBy?.at(-1)?.expression;
                // This fixture's physical schema is string PK + finite numeric/boolean
                // order fields. Production admission is tested separately against IR.
                return (
                    capable && final?.type === "ref" && IR.getPropRefPropertyPath(final).join(".") === "id"
                );
            },
            sync: ({ begin, write, commit, markReady, invalidateLoadedSubsets }) => {
                publish = (changes) => {
                    begin();
                    for (const change of changes) {
                        write(change);
                        if (change.type === "delete") {
                            const key = "key" in change ? change.key : change.value.id;
                            if (key !== undefined) installed.delete(key);
                        } else installed.add(change.value.id);
                    }
                    return commit();
                };
                install = (options) =>
                    publish(
                        selected(options).map((value) => ({
                            type: installed.has(value.id) ? "update" : "insert",
                            value,
                        }))
                    );
                invalidate = invalidateLoadedSubsets;
                markReady();
                return {
                    loadSubset: (options) => {
                        const values = selected(options);
                        const call = { options, count: values.length, active: true, keys: ids(values) };
                        calls.push(call);
                        const receipt = install(options);
                        if (fail?.(options)) {
                            fail = undefined;
                            return Promise.resolve(receipt).then(() => {
                                throw new Error("planned prefix failure");
                            });
                        }
                        if (hold?.predicate(options)) {
                            const current = hold;
                            hold = undefined;
                            current.entered.resolve(call);
                            return Promise.resolve(receipt).then(() => current.released.promise);
                        }
                        return receipt;
                    },
                    unloadSubset: (options) => {
                        const call = calls
                            .slice()
                            .reverse()
                            .find((call) => call.options === options && call.active);
                        if (call) call.active = false;
                    },
                };
            },
        },
    });
    return {
        collection,
        calls,
        get rows() {
            return rows;
        },
        edit(value: Row) {
            rows = rows.map((row) => (row.id === value.id ? value : row));
            return publish([{ type: "update", value }]);
        },
        replace(values: Row[]) {
            rows = values.slice();
        },
        prime() {
            return publish(
                rows.map((value) => ({ type: installed.has(value.id) ? "update" : "insert", value }))
            );
        },
        invalidate() {
            invalidate();
        },
        async refetch() {
            const active = calls.filter((call) => call.active);
            const previous = new Set(active.flatMap((call) => call.keys));
            const next = new Set(active.flatMap((call) => ids(selected(call.options))));
            // A refetch must also publish departure from the adapter's loaded pages.
            // Merely writing new page rows leaves stale former members in local order.
            const removed = [...previous].filter((key) => !next.has(key) && installed.has(key));
            if (removed.length) await publish(removed.map((key) => ({ type: "delete", key })));
            for (const call of active) {
                call.keys = ids(selected(call.options));
                await install(call.options);
            }
            invalidate();
        },
        failNext(predicate: (options: LoadSubsetOptions) => boolean) {
            fail = predicate;
        },
        holdNext(predicate: (options: LoadSubsetOptions) => boolean) {
            const current = {
                predicate,
                entered: deferred<Call>(),
                released: deferred<void>(),
            };
            hold = current;
            return { entered: current.entered.promise, release: () => current.released.resolve() };
        },
    };
}
const notes = (s: ReturnType<typeof source>, offset = 0, limit = 51) =>
    createLiveQueryCollection({
        query: (q) =>
            q
                .from({ note: s.collection })
                .where(({ note }) => eq(note.trashed, true))
                .orderBy(({ note }) => note.favorite, "desc")
                .orderBy(({ note }) => note.rank, "desc")
                .orderBy(({ note }) => note.id, "asc")
                .offset(offset)
                .limit(limit),
    });

test("nonzero offset and later window movement read complete prefixes, never scalar-index pages", async () => {
    const s = source();
    const result = notes(s, 70, 31);
    try {
        await result.preload();
        expect(ids(result.toArray)).toEqual(oracle(s.rows, 70, 31));
        expect(s.calls.every((call) => !call.options.cursor && call.options.offset === undefined)).toBe(true);
        expect(s.calls.some((call) => call.options.limit === 101)).toBe(true);
        await result.utils.setWindow({ offset: 100, limit: 51 });
        expect(ids(result.toArray)).toEqual(oracle(s.rows, 100, 51));
        expect(s.calls.every((call) => call.count <= 151)).toBe(true);
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a pending optimistic deletion refills from the authoritative prefix and rollback restores its first row", async () => {
    const s = source();
    const result = notes(s);
    const optimistic = createTransaction<Row>({ autoCommit: false, mutationFn: async () => {} });
    try {
        await result.preload();
        optimistic.mutate(() => s.collection.delete("0000"));
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows.slice(1)));
        expect(s.calls.every((call) => call.count <= 104)).toBe(true);
        optimistic.rollback();
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows));
        expect(s.calls.every((call) => !call.options.cursor)).toBe(true);
    } finally {
        if (optimistic.state === "pending") optimistic.rollback();
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("refetched pages followed by invalidation repair a shifted composite prefix", async () => {
    const s = source();
    const result = notes(s);
    try {
        await result.preload();
        s.replace(s.rows.map((row) => (row.id === "0000" ? { ...row, rank: -1 } : row)));
        await s.refetch();
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows));
        await result.utils.setWindow({ offset: 0, limit: 101 });
        expect(ids(result.toArray)).toEqual(oracle(s.rows, 0, 101));
        expect(s.calls.every((call) => call.count <= 101)).toBe(true);
        expect(s.calls.some((call) => call.options.refetch && call.options.limit !== undefined)).toBe(true);
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a late old page receipt cannot replace a newer ordering repair", async () => {
    const s = source();
    const result = notes(s);
    let release: (() => void) | undefined;
    try {
        await result.preload();
        const oldPage = s.holdNext((options) => options.limit === 101 && !options.refetch);
        release = oldPage.release;
        const moving = result.utils.setWindow({ offset: 0, limit: 101 });
        await oldPage.entered;
        await s.edit({ ...s.rows[0]!, rank: -1 });
        await expect
            .poll(() => s.calls.some((call) => call.options.refetch && call.options.limit === 101))
            .toBe(true);
        oldPage.release();
        await moving;
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows, 0, 101));
        expect(s.calls.every((call) => call.count <= 101)).toBe(true);
    } finally {
        release?.();
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("an unchanged refetch with a closed tuple boundary does not start a spurious repair", async () => {
    const s = source();
    await s.collection.preload();
    await s.prime();
    const result = notes(s);
    try {
        await result.preload();
        const before = s.calls.length;
        await s.refetch();
        await Promise.resolve();
        await Promise.resolve();
        expect(ids(result.toArray)).toEqual(oracle(s.rows));
        expect(s.calls).toHaveLength(before);
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a missing unique final key retains conservative tie loading", async () => {
    const rows = seed(400).map((row) => ({ ...row, rank: Math.floor(Number(row.id) / 100) }));
    const s = source(rows.reverse());
    const result = createLiveQueryCollection({
        query: (q) =>
            q
                .from({ note: s.collection })
                .orderBy(({ note }) => note.favorite)
                .orderBy(({ note }) => note.rank, "desc")
                .offset(20)
                .limit(31),
    });
    try {
        await result.preload();
        const expected = rows
            .slice()
            .sort((a, b) => Number(b.rank) - Number(a.rank) || (a.id < b.id ? -1 : 1));
        expect(ids(result.toArray)).toEqual(ids(expected.slice(20, 51)));
        expect(s.calls.some((call) => call.count === 400)).toBe(true);
        expect(s.calls.every((call) => call.count <= 400)).toBe(true);
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a computed local filter after a pushable filter keeps the complete filtered-source fallback", async () => {
    const rows = seed(100).map((row, index) => ({ ...row, trashed: index % 2 === 0 }));
    const s = source(rows);
    const result = createLiveQueryCollection({
        query: (q) =>
            q
                .from({ note: s.collection })
                .where(({ note }) => eq(note.trashed, true))
                .fn.where(({ note }) => Number(note.rank) < 30)
                .orderBy(({ note }) => note.favorite)
                .orderBy(({ note }) => note.rank)
                .orderBy(({ note }) => note.id)
                .limit(4),
    });
    try {
        await result.preload();
        expect(ids(result.toArray)).toEqual(
            ids(
                rows
                    .filter((row) => row.trashed && Number(row.rank) < 30)
                    .sort((a, b) => Number(a.rank) - Number(b.rank))
                    .slice(0, 4)
            )
        );
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0]).toMatchObject({ count: 50, options: { limit: undefined } });
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("an optimistic trailing-sort move refills from a bounded prefix and rollback restores order", async () => {
    const s = source();
    const result = notes(s);
    const optimistic = createTransaction<Row>({ autoCommit: false, mutationFn: async () => {} });
    try {
        await result.preload();
        optimistic.mutate(() =>
            s.collection.update("0000", (draft) => {
                draft.rank = -1;
            })
        );
        await expect
            .poll(() => ids(result.toArray))
            .toEqual(oracle(s.rows.map((row) => (row.id === "0000" ? { ...row, rank: -1 } : row))));
        optimistic.rollback();
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows));
        expect(s.calls.every((call) => call.options.limit !== undefined && !call.options.cursor)).toBe(true);
    } finally {
        if (optimistic.state === "pending") optimistic.rollback();
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a persisting optimistic deletion stays correct through source confirmation and receipt release", async () => {
    const s = source();
    const result = notes(s);
    const persisted = deferred<void>();
    const optimistic = createTransaction<Row>({ mutationFn: () => persisted.promise });
    try {
        await result.preload();
        optimistic.mutate(() => s.collection.delete("0000"));
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows.slice(1)));
        s.replace(s.rows.filter((row) => row.id !== "0000"));
        const refetching = s.refetch();
        persisted.resolve();
        await optimistic.when("settled");
        await refetching;
        await expect.poll(() => ids(result.toArray)).toEqual(oracle(s.rows));
        expect(s.calls.every((call) => call.options.limit !== undefined && !call.options.cursor)).toBe(true);
    } finally {
        persisted.resolve();
        if (optimistic.state === "pending") optimistic.rollback();
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test.each([true, false])(
    "exact prefix capability %s preserves results with bounded work only when admitted",
    async (capable: boolean) => {
        const s = source(seed(), capable);
        const result = notes(s);
        try {
            await result.preload();
            expect(ids(result.toArray)).toEqual(oracle(s.rows));
            expect(s.calls.map((call) => call.count)).toEqual(capable ? [51] : [51, 1400]);
        } finally {
            await result.cleanup();
            await s.collection.cleanup();
        }
    }
);

test("unknown mixed domains retain the leading tie instead of using strict tuple equality", async () => {
    const s = source(
        [
            { id: "z", favorite: false, rank: false, trashed: true },
            { id: "a", favorite: false, rank: 0, trashed: true },
            { id: "later", favorite: false, rank: -1, trashed: true },
        ],
        false
    );
    const result = notes(s, 0, 1);
    try {
        await result.preload();
        expect(ids(result.toArray)).toEqual(["a"]);
        expect(s.calls.some((call) => call.count === 3 && call.options.limit === undefined)).toBe(true);
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a failed prefix growth retains the previous public window and an explicit retry recovers", async () => {
    const s = source();
    const result = notes(s);
    try {
        await result.preload();
        s.failNext((options) => options.limit === 101);
        await Promise.resolve(result.utils.setWindow({ offset: 0, limit: 101 })).catch(() => undefined);
        expect(ids(result.toArray)).toEqual(oracle(s.rows));
        await result.utils.setWindow({ offset: 0, limit: 101 });
        expect(ids(result.toArray)).toEqual(oracle(s.rows, 0, 101));
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("cleanup aborts a held prefix growth and releases all acquisition owners", async () => {
    const s = source();
    const result = notes(s);
    let release: (() => void) | undefined;
    try {
        await result.preload();
        const held = s.holdNext((options) => options.limit === 101);
        release = held.release;
        const moving = Promise.resolve(result.utils.setWindow({ offset: 0, limit: 101 })).catch(
            () => undefined
        );
        const call = await held.entered;
        await result.cleanup();
        expect(call.options.signal?.aborted).toBe(true);
        expect(s.calls.every((entry) => !entry.active)).toBe(true);
        held.release();
        await moving;
    } finally {
        release?.();
        await result.cleanup();
        await s.collection.cleanup();
    }
});

test("a later negative offset uses the established full-source fallback", async () => {
    const s = source();
    const result = notes(s);
    try {
        await result.preload();
        await result.utils.setWindow({ offset: -3, limit: 5 });
        expect(s.calls.some((call) => call.options.limit === undefined && call.count === 1400)).toBe(true);
        expect(ids(result.toArray)).toEqual(oracle(s.rows, 0, 2));
    } finally {
        await result.cleanup();
        await s.collection.cleanup();
    }
});
