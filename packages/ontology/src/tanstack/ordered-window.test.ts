import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR, type TypeDef } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { createLiveQueryCollection, eq, IR, type LoadSubsetOptions } from "@tanstack/db";
import { Effect, Stream } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeReplicatedCollection } from "./collections.js";
import { analyzeOntologySubset } from "./subset.js";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

// ReplicaService values in this file are structural test doubles, not native
// owners. Keep all real infrastructure exports; their revision fence is fixed.
vi.mock("@party-stack/ontology-replica/infrastructure", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@party-stack/ontology-replica/infrastructure")>();
    const { Effect } = await import("effect");
    return { ...actual, readVisibleRevision: () => Effect.succeed(0) };
});

const property = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const definition = (rank: TypeDef = o.timestamp({})): OntologyIR => ({
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                property("id", o.string({})),
                property("rank", rank),
                property("pinned", o.boolean({})),
                property("trashed", o.boolean({})),
            ],
        },
    ],
});
const term = (name: string) => ({
    expression: new IR.PropRef([name]),
    compareOptions: { direction: "asc" as const, nulls: "last" as const, stringSort: "lexical" as const },
});
const request = (): LoadSubsetOptions => ({ orderBy: [term("rank"), term("id")], limit: 51 });
const admits = (options: LoadSubsetOptions, ir = definition()) =>
    analyzeOntologySubset(options, ir, "Note").orderedWindowExact;

test.each([
    o.boolean({}),
    o.integer({}),
    o.float({}),
    o.double({}),
    o.string({}),
    o.timestamp({}),
    o.date({}),
    o.optional({ type: o.integer({}) }),
])("finite ordered windows use declared scalar types, including %j", (type) => {
    expect(admits(request(), definition(type))).toBe(true);
});

test("ordered windows decline uncertain domains, incomplete ordering and inexact pushdown", () => {
    expect(admits(request(), definition(o.unknown({})))).toBe(false);
    expect(admits(request(), definition(o.list({ elementType: o.string({}) })))).toBe(false);
    expect(admits({ ...request(), orderBy: [term("missing"), term("id")] })).toBe(false);
    expect(admits({ ...request(), orderBy: [term("rank")] })).toBe(false);
    expect(admits({ ...request(), orderBy: [term("id"), term("rank")] })).toBe(false);
    const optionalKey = definition();
    optionalKey.objectTypes[0]!.properties[0]!.type = o.optional({ type: o.string({}) });
    expect(admits(request(), optionalKey)).toBe(false);
    for (const limit of [undefined, -1, Infinity, 1.5]) expect(admits({ ...request(), limit })).toBe(false);
    for (const offset of [-1, Infinity, 1.5]) expect(admits({ ...request(), offset })).toBe(false);
    const locale = request();
    locale.orderBy![1]!.compareOptions.stringSort = "locale";
    expect(admits(locale)).toBe(false);
    const custom = request();
    custom.orderBy![0]!.compareOptions = {
        direction: "asc",
        nulls: "last",
        stringSort: "custom",
        compare: () => 0,
    };
    expect(admits(custom)).toBe(false);
    expect(admits({ ...request(), where: new IR.Func("unsupported", [new IR.PropRef(["rank"])]) })).toBe(
        false
    );
});

test.each([false, true])(
    "native timestamp windows stay bounded, with pinned ordering=%s",
    async (pinsFirst) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const ir = definition();
                    const instant = Temporal.Instant.from("2026-11-09T00:00:00Z");
                    const rows = Array.from({ length: 1400 }, (_, index) => ({
                        key: String(index).padStart(4, "0"),
                        value: {
                            id: String(index).padStart(4, "0"),
                            pinned: false,
                            trashed: true,
                            rank: instant.add({ nanoseconds: index }),
                        },
                    }));
                    const acquired: ObjectSubset[] = [];
                    const read = (subset: ObjectSubset) =>
                        Effect.map(compileObjectSubset(ir, subset), (scan) =>
                            evaluateQuery(rows, scan.query)
                        );
                    const replica = {
                        ir,
                        readSubset: read,
                        observeSubset: (subset: ObjectSubset) =>
                            Stream.fromEffect(
                                Effect.map(read(subset), (selected) => ({
                                    revision: 0,
                                    reset: true,
                                    rows: selected,
                                    removed: [],
                                }))
                            ),
                        demand: {
                            acquire: (subset: ObjectSubset) =>
                                Effect.sync(() => {
                                    acquired.push(subset);
                                }),
                        },
                    } as unknown as ReplicaService;
                    const source = yield* makeReplicatedCollection<(typeof rows)[number]["value"]>({
                        id: `exact-window-${pinsFirst}`,
                        replica,
                        objectType: "Note",
                        getKey: (row) => row.id,
                    });
                    const result = createLiveQueryCollection({
                        query: (q) => {
                            let query = q.from({ note: source }).where(({ note }) => eq(note.trashed, true));
                            if (pinsFirst) query = query.orderBy(({ note }) => note.pinned, "desc");
                            return query
                                .orderBy(({ note }) => note.rank, "desc")
                                .orderBy(({ note }) => note.id, "asc")
                                .limit(51);
                        },
                    });
                    yield* Effect.addFinalizer(() => Effect.promise(() => result.cleanup()));
                    yield* Effect.promise(() => result.preload());
                    expect(result.toArray.map((row) => row.id)).toEqual(
                        rows
                            .slice(-51)
                            .reverse()
                            .map((row) => row.key)
                    );
                    expect(acquired.map((subset) => subset.page?.limit)).toEqual([51]);
                    yield* Effect.promise(() =>
                        Promise.resolve(result.utils.setWindow({ offset: 0, limit: 101 }))
                    );
                    expect(result.toArray.map((row) => row.id)).toEqual(
                        rows
                            .slice(-101)
                            .reverse()
                            .map((row) => row.key)
                    );
                    expect(
                        acquired.every(
                            (subset) => subset.page?.limit !== undefined && subset.page.limit <= 101
                        )
                    ).toBe(true);
                })
            )
        );
    }
);
