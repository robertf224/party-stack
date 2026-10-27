import { Effect } from "effect";
import { expect, test } from "vitest";
import * as Memory from "../memory/tables.js";
import { field, Table } from "../model.js";
import { getBaseline, getVisible, loadBaseline, loadVisible, overlay } from "./index.js";

test("received predictions compose below local predictions without materializing another base", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const base = Table.make<{ rank: number }>({ name: "base" });
            const inherited = overlay(base, { name: "received" }).overrides;
            const view = overlay(base, { name: "own", inherited });
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    for (const [i, key] of ["a", "b", "c", "d"].entries())
                        yield* tx.put(base, key, { rank: i + 1 });
                    yield* tx.put(inherited, "a", { deleted: true });
                    yield* tx.put(inherited, "b", { deleted: false, value: { rank: 9 } });
                    yield* tx.put(inherited, "x", { deleted: false, value: { rank: 0 } });
                    yield* tx.put(view.overrides, "b", { deleted: false, value: { rank: -1 } });
                    yield* tx.put(view.overrides, "x", { deleted: true });
                    const window = { orderBy: [{ field: field("rank") }], offset: 1, limit: 2 };
                    expect((yield* loadBaseline(tx, view, window)).map((row) => row.key)).toEqual(["c", "d"]);
                    expect((yield* loadVisible(tx, view, window)).map((row) => row.key)).toEqual(["c", "d"]);
                    expect(yield* getBaseline(tx, view, "b")).toEqual({ rank: 9 });
                    expect(yield* getVisible(tx, view, "b")).toEqual({ rank: -1 });
                    expect(yield* getVisible(tx, view, "a")).toBeUndefined();
                    expect(yield* getVisible(tx, view, "x")).toBeUndefined();
                    yield* tx.put(view.overrides, "a", { deleted: false, value: { rank: 5 } });
                    expect(yield* getVisible(tx, view, "a")).toEqual({ rank: 5 });
                    expect(yield* getBaseline(tx, view, "a")).toBeUndefined();
                    expect(yield* tx.get(base, "b")).toEqual({ rank: 2 });
                })
            );
        })
    );
});
