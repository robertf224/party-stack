import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeReplica } from "@party-stack/ontology-replica";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { field, selectField, sub, input, eq as queryEq } from "@party-stack/ontology-spec/query";
import { MemoryRuntime, Runtimes, Runtime } from "@party-stack/runtime";
import { DbClient, queryOnce, eq } from "@tanstack/db";
import { Deferred, Effect } from "effect";
import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import { createLiveOntology } from "./LiveOntology.js";
import { definePin, makeOntologyPins } from "./pins.js";

const ir: OntologyIR = {
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
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
};
const document = {
    select: [
        sub("notes", {
            from: { source: { objectType: "Note" }, binding: "note" },
            select: [selectField("id", field("note", "id"))],
        }),
    ],
};

test("pin collections use ordinary optimistic replica writes before the owner confirms", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const runtimes = yield* Runtimes;
                const runtime = yield* runtimes.acquire({ owner: "device", namespace: "pin-sdk" });
                const source = makeOntologyBackend({
                    ir,
                    name: "notes",
                    sourceId: "notes",
                    supportsIdempotency: true,
                    loadSubset: () =>
                        Effect.succeed({ complete: true, rows: [{ key: "one", value: { id: "one" } }] }),
                    applyAction: () => Effect.die("Unexpected application action"),
                    queryFunction: () => Effect.void,
                });
                const owner = yield* makeReplica({ ir, backend: source }).pipe(
                    Effect.provideService(Runtime, runtime)
                );
                const backend = yield* owner.demand.pins.backend;
                const release = yield* Deferred.make<void>();
                let starts = 0;
                const delayed = {
                    ...backend,
                    applyAction: (request: Parameters<typeof backend.applyAction>[0]) =>
                        Effect.sync(() => {
                            starts++;
                        }).pipe(
                            Effect.andThen(Deferred.await(release)),
                            Effect.andThen(backend.applyAction(request))
                        ),
                };
                const dbClient = new DbClient();
                yield* Effect.addFinalizer(() => Effect.promise(() => dbClient.cleanup()));
                const pins = yield* makeOntologyPins({ backend: Effect.succeed(delayed), dbClient }).pipe(
                    Effect.provideService(Runtime, runtime)
                );
                const definition = definePin("allNotes", { query: document });
                const family = pins(definition);
                const subscription = family.collection.subscribeChanges(() => {}, {
                    includeInitialState: true,
                });
                yield* Effect.addFinalizer(() => Effect.sync(() => subscription.unsubscribe()));
                yield* Effect.promise(() => queryOnce((q) => q.from({ pin: family.collection })));
                let setting: Promise<void>;
                let removing: Promise<void>;
                yield* Effect.promise(async () => {
                    setting = family.set();
                    await vi.waitFor(() => {
                        expect(starts).toBe(1);
                        expect(family.collection.get(family.id())).toMatchObject({
                            ready: false,
                            name: "allNotes",
                        });
                    });
                    removing = family.remove();
                    await vi.waitFor(() => expect(family.collection.has(family.id())).toBe(false));
                });
                expect(yield* owner.demand.pins.list).toEqual([]);
                yield* Deferred.succeed(release, undefined);
                yield* Effect.promise(() => Promise.all([setting!, removing!]));
                expect(yield* owner.demand.pins.list).toEqual([]);
            })
        ).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
    );
});

test("descriptor input types and canonical identity do not need registration", () => {
    const folders = definePin<{ folderId: string }>("folder", { query: document });
    expectTypeOf(folders).toEqualTypeOf<import("./pins.js").PinDescriptor<{ folderId: string }>>();
    expect(folders.name).toBe("folder");
});

test("applications can join typed pin inputs to objects and command the family without a hook", async () => {
    const backend = makeOntologyBackend({
        ir,
        name: "notes",
        sourceId: "notes",
        supportsIdempotency: true,
        loadSubset: () => Effect.succeed({ complete: true, rows: [{ key: "one", value: { id: "one" } }] }),
        applyAction: () => Effect.die("Unexpected application action"),
        queryFunction: () => Effect.void,
    });
    const ontology = await createLiveOntology({ ir, backend });
    const definition = definePin<{ noteId: string }>("notes", {
        query: {
            inputs: [{ name: "noteId", displayName: "Note", type: o.string({}) }],
            select: [
                sub("note", {
                    from: { source: { objectType: "Note" }, binding: "note" },
                    where: queryEq(field("note", "id"), input("noteId")),
                    select: [selectField("id", field("note", "id"))],
                }),
            ],
        },
    });
    const downloads = ontology.pins(definition);
    expectTypeOf(downloads.set).parameters.toEqualTypeOf<[inputs: { noteId: string }]>();
    const read = () =>
        queryOnce((q) =>
            q
                .from({ note: ontology.objects.Note! })
                .leftJoin({ pin: downloads.collection }, ({ note, pin }) => eq(note.id, pin.inputs.noteId))
                .select(({ note, pin }) => ({ id: note.id, pinId: pin.id, ready: pin.ready }))
        );
    try {
        expect(await read()).toMatchObject([{ id: "one", pinId: undefined }]);
        await downloads.set({ noteId: "one" });
        await vi.waitFor(async () =>
            expect(await read()).toMatchObject([
                { id: "one", pinId: downloads.id({ noteId: "one" }), ready: true },
            ])
        );
        await ontology.pins(definePin("other", { query: document })).set();
        expect(await read()).toHaveLength(1);
        await downloads.remove({ noteId: "one" });
        expect(await read()).toMatchObject([{ id: "one", pinId: undefined }]);
    } finally {
        await ontology.cleanup();
    }
});
