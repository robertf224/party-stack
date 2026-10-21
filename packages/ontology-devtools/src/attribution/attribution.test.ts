import {
    persistedCollectionOptions,
    scopedCollection,
    storageSubset,
    getCollectionDemands,
} from "@party-stack/runtime";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import { Effect, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { registerQueryConsumer, queryConsumers } from "./registry.js";
import { queryDemandGraph, demandOwners } from "./tanstack.js";
import type { OntologyIR } from "@party-stack/ontology";

const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: { kind: "string", value: {} } }],
        },
    ],
};

test("actual TanStack subscription identities attribute shared queries to each instance without acquiring extra demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let acquisitions = 0;
                const source = yield* scopedCollection(
                    yield* persistedCollectionOptions<{ id: string }, string>({
                        id: "attribution-notes",
                        getKey: (row) => row.id,
                        changes: Stream.never,
                        load: Effect.succeed([]),
                        acquireDemand: Effect.sync(() => {
                            acquisitions++;
                        }),
                        describeSubset: (subset) => ({
                            objectType: "Note",
                            query: storageSubset(subset, ir, "Note"),
                        }),
                    })
                );
                const query = createLiveQueryCollection((q) =>
                    q
                        .from({ note: source })
                        .where(({ note }) => eq(note.id, "one"))
                        .orderBy(({ note }) => note.id)
                );
                const subscription = query.subscribeChanges(() => {});
                const dispose = [
                    registerQueryConsumer(
                        { id: "instance-a", name: "NoteList", source: "List.tsx:1" },
                        query
                    ),
                    registerQueryConsumer(
                        { id: "instance-b", name: "NoteList", source: "List.tsx:1" },
                        query
                    ),
                    registerQueryConsumer(
                        { id: "instance-a", name: "NoteList", source: "List.tsx:1" },
                        query
                    ),
                ];
                yield* Effect.addFinalizer(() =>
                    Effect.promise(async () => {
                        dispose.forEach((release) => release());
                        subscription.unsubscribe();
                        await query.cleanup();
                    })
                );
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(getCollectionDemands(source)).toHaveLength(1))
                );
                const graph = queryDemandGraph(query);
                expect(graph).toHaveLength(1);
                expect(graph[0]?.query?.where).toEqual({
                    op: "eq",
                    left: { _tag: "Field", path: ["id"] },
                    right: "one",
                });
                const before = acquisitions;
                expect(demandOwners(graph[0]!, [source]).map((owner) => owner.id)).toEqual([
                    "instance-a",
                    "instance-b",
                ]);
                expect(demandOwners(graph[0]!, [{}])).toEqual([]);
                expect(acquisitions).toBe(before);
                dispose[0]!();
                dispose[2]!();
                expect(demandOwners(graph[0]!, [source]).map((owner) => owner.id)).toEqual(["instance-b"]);
            })
        )
    );
    expect(queryConsumers()).toEqual([]);
});

test("unknown TanStack graph shapes fail closed", () => {
    expect(queryDemandGraph({})).toEqual([]);
    expect(
        queryDemandGraph({
            utils: {
                [Symbol("liveQueryInternal")]: {
                    getBuilder: () => {
                        throw new Error("Changed internals");
                    },
                },
            },
        })
    ).toEqual([]);
});

test("pooled result inspection never touches the materializing proxy getter", () => {
    const source = {};
    const materialize = vi.fn(() => {
        throw new Error("Inspection materialized a query");
    });
    const proxy = new Proxy(
        { source, partition: { source, subscription: {} }, groupKey: "group", collection: undefined },
        {
            get: materialize,
        }
    );
    expect(queryDemandGraph(proxy)).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();
});
