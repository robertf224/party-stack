import { o } from "@party-stack/ontology-spec";
import { and, contains, eq, field, inArray, ilike, like, or } from "@party-stack/ontology-storage";
import { Effect, Exit, Scope, Stream, Fiber } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeFoundryBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyIR } from "@party-stack/ontology-spec";

const mocks = vi.hoisted(() => ({ watcher: vi.fn(), fetch: vi.fn() }));
vi.mock("@party-stack/foundry-object-set-watcher", () => ({ makeObjectSetWatcher: mocks.watcher }));
vi.mock("./foundryObjectSearch.js", () => ({ searchFoundryObjects: mocks.fetch }));

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
};

test("native snapshots stay native with a users integration, and watcher resources belong to the binding scope", async () => {
    const subscribe = vi.fn(() =>
        Stream.concat(Stream.make({ type: "state", status: "open" }), Stream.never)
    );
    const release = vi.fn();
    mocks.watcher.mockReturnValue(
        Effect.acquireRelease(Effect.succeed({ subscribe }), () => Effect.sync(release))
    );
    mocks.fetch.mockResolvedValue([{ id: "one" }]);
    const scope = Effect.runSync(Scope.make());
    try {
        const backend = await Effect.runPromise(
            Scope.provide(
                makeFoundryBackend({
                    client: {
                        baseUrl: "https://foundry.example",
                        ontologyRid: "ontology",
                        fetch: vi.fn(),
                    } as unknown as OntologyClient,
                    ir,
                    context: {},
                    users: { objectType: "User", loadSubset: async () => ({ rows: [], complete: true }) },

                    submitAction: () => {
                        throw new Error("Unexpected action");
                    },
                    decodeObject: (_type, value) => value,
                }),
                scope
            )
        );
        expect(subscribe).not.toHaveBeenCalled();
        expect(await Effect.runPromise(backend.loadSubset({ objectType: "Issue" }))).toEqual({
            complete: true,
            fetchedRows: 1,
            pushdown: {
                source: "Foundry",
                predicates: [],
                sorting: "none",
                pagination: "none",
                rechecksFilter: false,
                native: { language: "json", text: JSON.stringify({ type: "and", value: [] }, null, 2) },
            },
            rows: [{ key: "one", value: { id: "one" } }],
        });

        expect(backend.watchSubset?.({ objectType: "User" })).toBeUndefined();
        expect(backend.pollIntervalMs?.({ objectType: "User" })).toBe(60_000);
        expect(backend.pollIntervalMs?.({ objectType: "Issue" })).toBeUndefined();
        expect(subscribe).not.toHaveBeenCalled();
        let invalidations = 0;
        await Effect.runPromise(
            Scope.provide(
                Effect.forkScoped(
                    Stream.runForEach(backend.watchSubset!({ objectType: "Issue" })!, () =>
                        Effect.sync(() => {
                            invalidations++;
                        })
                    ),
                    { startImmediately: true }
                ),
                scope
            )
        );
        expect(subscribe).toHaveBeenCalledWith({ type: "base", objectType: "Issue" });
        await vi.waitFor(() => expect(invalidations).toBe(1));
    } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    expect(release).toHaveBeenCalledOnce();
});

test("native action submission returns complete identity targets without opening legacy collections", async () => {
    const subscribe = vi.fn(() => Stream.never);
    mocks.watcher.mockReturnValue(Effect.succeed({ subscribe }));
    const submitAction = vi.fn<Parameters<typeof makeFoundryBackend>[0]["submitAction"]>().mockResolvedValue({
        result: {
            operationId: "remote-operation",
            edits: {
                type: "edits",
                addedObjectCount: 1,
                modifiedObjectsCount: 1,
                deletedObjectsCount: 1,
                addedLinksCount: 0,
                deletedLinksCount: 0,
                edits: [
                    { type: "modifyObject", objectType: "Issue", primaryKey: "one" },
                    { type: "deleteObject", objectType: "Issue", primaryKey: "two" },
                    { type: "addObject", objectType: "Issue", primaryKey: "one" },
                ],
            },
        },
        attachmentIdMappings: [],
    });
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},

                    submitAction,
                    decodeObject: (_type, value) => value,
                });
                const invocation = { id: "local-invocation", name: "editIssue", parameters: {} };
                expect(yield* backend.invoke(invocation)).toMatchObject({
                    invocationId: "local-invocation",
                    outcome: "committed",
                    operationId: "remote-operation",
                    affected: [{ objectType: "Issue", keys: ["one", "two"] }],
                });
                expect(submitAction).toHaveBeenCalledWith(invocation, expect.any(AbortSignal));

                expect(subscribe).not.toHaveBeenCalled();
            })
        )
    );
});

test("identity subsets use the shared search path with an IN predicate and propagate denied reads", async () => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue([{ id: "one" }]);
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: { ontologyRid: "ontology", fetch: vi.fn() } as unknown as OntologyClient,
                    ir,
                    context: {},
                    live: false,

                    submitAction: () => {
                        throw new Error("Unexpected action");
                    },
                    decodeObject: (_type, value) => value,
                });
                expect(
                    yield* backend.loadSubset({
                        objectType: "Issue",
                        query: { where: inArray(field("id"), ["one", "gone", "one"]) },
                    })
                ).toEqual({
                    complete: true,
                    fetchedRows: 1,
                    rows: [{ key: "one", value: { id: "one" } }],
                    pushdown: {
                        source: "Foundry",
                        predicates: [{ path: [], execution: "source" }],
                        sorting: "none",
                        pagination: "none",
                        rechecksFilter: true,
                        native: {
                            language: "json",
                            text: JSON.stringify(
                                { type: "in", field: "id", value: ["one", "gone"] },
                                null,
                                2
                            ),
                        },
                    },
                });
                expect(mocks.fetch).toHaveBeenCalledOnce();
                expect(mocks.fetch.mock.calls[0]?.[3]).toMatchObject({
                    where: { type: "in", field: "id", value: ["one", "gone"] },
                });
                mocks.fetch.mockRejectedValue({ statusCode: 403 });
                expect(
                    (yield* Effect.result(
                        backend.loadSubset({
                            objectType: "Issue",
                            query: { where: inArray(field("id"), ["one"]) },
                        })
                    ))._tag
                ).toBe("Failure");
            })
        )
    );
});

test("large-scale action receipts identify a type without pretending to enumerate its rows", async () => {
    const submitAction = vi.fn<Parameters<typeof makeFoundryBackend>[0]["submitAction"]>().mockResolvedValue({
        result: { edits: { type: "largeScaleEdits", editedObjectTypes: ["Issue"] } },
        attachmentIdMappings: [],
    });
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},
                    live: false,

                    submitAction,
                    decodeObject: (_type, value) => value,
                });
                expect(
                    (yield* backend.invoke({ id: "bulk", name: "edit", parameters: {} })).affected
                ).toEqual([{ objectType: "Issue" }]);
            })
        )
    );
});

test("a denied or QoS-limited watcher fails explicitly so Replica can fall back to polling", async () => {
    mocks.watcher.mockReturnValue(
        Effect.succeed({
            subscribe: () => Stream.make({ type: "state", status: "qos" }),
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},
                    submitAction: () => {
                        throw new Error("Unexpected action");
                    },

                    decodeObject: (_type, value) => value,
                });
                const fiber = yield* Effect.forkScoped(
                    Stream.runDrain(backend.watchSubset!({ objectType: "Issue" })!)
                );
                const result = yield* Effect.result(Fiber.join(fiber));
                expect(result._tag === "Failure" && result.failure.kind).toBe("Unavailable");
            })
        )
    );
});

test("HTTP reads and watches use the same conservative subset filter while window evaluation stays local", async () => {
    const subscribe = vi.fn(() => Stream.never);
    mocks.watcher.mockReturnValue(Effect.succeed({ subscribe }));
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue([
        { id: "b", project: "one", rank: 2, title: "hello b" },
        { id: "a", project: "one", rank: 1, title: "hello a" },
        { id: "c", project: "one", rank: 0, title: "other" },
    ]);
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: { ontologyRid: "ontology", fetch: vi.fn() } as unknown as OntologyClient,
                    ir,
                    context: {},

                    submitAction: () => {
                        throw new Error("Unexpected action");
                    },
                    decodeObject: (_type, value) => value,
                });
                const subset = {
                    objectType: "Issue",
                    query: {
                        where: and(eq(field("project"), "one"), like(field("title"), "%hello%")),
                        orderBy: [{ field: field("rank") }],
                        limit: 1,
                    },
                };
                backend.watchSubset!(subset);
                const filter = {
                    type: "and",
                    value: [
                        { type: "eq", field: "project", value: "one" },
                        {
                            type: "containsAllTermsInOrder",
                            propertyIdentifier: { type: "property", apiName: "title" },
                            value: "hello",
                        },
                    ],
                };
                expect(subscribe).toHaveBeenCalledWith({
                    type: "filter",
                    objectSet: { type: "base", objectType: "Issue" },
                    where: filter,
                });
                const snapshot = yield* backend.loadSubset(subset);
                expect(snapshot.rows.map((row) => row.key)).toEqual(["a"]);
                expect(snapshot.fetchedRows).toBe(3);
                expect(snapshot.pushdown).toEqual({
                    source: "Foundry",
                    predicates: [
                        { path: [0], execution: "source" },
                        { path: [1], execution: "candidate" },
                    ],
                    sorting: "adapter",
                    pagination: "adapter",
                    rechecksFilter: true,
                    native: { language: "json", text: JSON.stringify(filter, null, 2) },
                });
                expect(mocks.fetch.mock.calls[0]?.[3]).toMatchObject({ where: filter });
                expect(mocks.fetch.mock.calls[0]?.[3]).not.toHaveProperty("limit");
                mocks.fetch.mockResolvedValue([
                    { id: "label", title: "unrelated", tags: ["urgent"] },
                    { id: "title", title: "Urgent title", tags: [] },
                    { id: "other", title: "other", tags: [] },
                ]);
                const search = {
                    objectType: "Issue",
                    query: {
                        where: or(ilike(field("title"), "urgent%"), contains(field("tags"), "urgent")),
                        limit: 1,
                        offset: 1,
                    },
                };
                backend.watchSubset!(search);
                const searched = yield* backend.loadSubset(search);
                expect(searched.rows.map((row) => row.key)).toEqual(["title"]);
                expect(searched.pushdown?.predicates).toEqual([
                    { path: [0], execution: "candidate" },
                    { path: [1], execution: "source" },
                ]);
                const native = JSON.parse(searched.pushdown!.native!.text);
                expect(native).toMatchObject({
                    type: "or",
                    value: [
                        { type: "wildcard", value: "urgent*" },
                        { type: "contains", field: "tags", value: "urgent" },
                    ],
                });
                expect(mocks.fetch.mock.calls.at(-1)?.[3]).toMatchObject({ where: native });
                expect(subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ where: native }));
            })
        )
    );
});
