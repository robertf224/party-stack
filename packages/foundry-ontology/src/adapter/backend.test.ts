import { objectSubset, resolveSubsetSnapshot } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { and, contains, eq, field, inArray, ilike, like, or } from "@party-stack/ontology-storage";
import { Effect, Exit, Redacted, Scope, Stream, Fiber } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { foundryWatchQosRetryMs, makeFoundryBackend, subscriptionStateError } from "./backend.js";
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
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "project", displayName: "Project", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
                { name: "tags", displayName: "Tags", type: o.list({ elementType: o.string({}) }) },
            ],
        },
    ],
};

test("native snapshots stay native with a users integration, and watcher resources belong to the binding scope", async () => {
    const subscribe = vi.fn(() =>
        Stream.concat(
            Stream.make({ type: "state", status: "open" }, { type: "change", updates: [] }),
            Stream.never
        )
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
        expect(await Effect.runPromise(loadSubset(backend, objectSubset("Issue")))).toEqual({
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

        expect(backend.watchSubset?.(objectSubset("User"))).toBeUndefined();
        expect(backend.refresh?.(objectSubset("User"))?.pollIntervalMs).toBe(60_000);
        expect(backend.refresh?.(objectSubset("Issue"))?.pollIntervalMs).toBeUndefined();
        expect(subscribe).not.toHaveBeenCalled();
        let invalidations = 0;
        await Effect.runPromise(
            Scope.provide(
                Effect.forkScoped(
                    backend.watchSubset!(objectSubset("Issue"))!.pipe(
                        Effect.flatMap((watch) =>
                            Stream.runForEach(watch, () =>
                                Effect.sync(() => {
                                    invalidations++;
                                })
                            )
                        )
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
    const subscribe = vi.fn(() =>
        Stream.concat(Stream.make({ type: "state", status: "open" }), Stream.never)
    );
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
                expect(yield* backend.applyAction(invocation)).toMatchObject({
                    operationId: "local-invocation",
                    outcome: "committed",
                    providerOperationId: "remote-operation",
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
                    watch: false,

                    submitAction: () => {
                        throw new Error("Unexpected action");
                    },
                    decodeObject: (_type, value) => value,
                });
                expect(
                    yield* loadSubset(
                        backend,
                        objectSubset("Issue", { where: inArray(field("id"), ["one", "gone", "one"]) })
                    )
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
                        loadSubset(backend, objectSubset("Issue", { where: inArray(field("id"), ["one"]) }))
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
                    watch: false,

                    submitAction,
                    decodeObject: (_type, value) => value,
                });
                expect(
                    (yield* backend.applyAction({ id: "bulk", name: "edit", parameters: {} })).affected
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
                    backend.watchSubset!(objectSubset("Issue"))!.pipe(Effect.flatMap(Stream.runDrain))
                );
                const result = yield* Effect.result(Fiber.join(fiber));
                expect(result._tag === "Failure" && result.failure).toMatchObject({
                    kind: "RateLimited",
                    retryable: true,
                    retryAfterMs: foundryWatchQosRetryMs,
                });
            })
        )
    );
});

test("HTTP reads and watches use the same conservative subset filter while window evaluation stays local", async () => {
    const subscribe = vi.fn(() =>
        Stream.concat(Stream.make({ type: "state", status: "open" }), Stream.never)
    );
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
                yield* Effect.forkScoped(
                    backend.watchSubset!(objectSubset(subset.objectType, subset.query))!.pipe(
                        Effect.flatMap(Stream.runDrain)
                    ),
                    { startImmediately: true }
                );
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
                const candidates = yield* backend.loadSubset(objectSubset(subset.objectType, subset.query));
                expect(candidates.rows).toHaveLength(3);
                expect(candidates.fulfilledSubset).toEqual(
                    objectSubset("Issue", { where: subset.query.where })
                );
                const snapshot = yield* loadSubset(backend, objectSubset(subset.objectType, subset.query));
                expect(snapshot.rows.map((row) => row.key)).toEqual(["a"]);
                expect(snapshot.fetchedRows).toBe(3);
                expect(snapshot.pushdown).toEqual({
                    source: "Foundry",
                    predicates: [
                        { path: [0], execution: "source" },
                        { path: [1], execution: "candidate" },
                    ],
                    sorting: "engine",
                    pagination: "engine",
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
                yield* Effect.forkScoped(
                    backend.watchSubset!(objectSubset(search.objectType, search.query))!.pipe(
                        Effect.flatMap(Stream.runDrain)
                    ),
                    { startImmediately: true }
                );
                const searched = yield* loadSubset(backend, objectSubset(search.objectType, search.query));
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

test("invalid subset windows fail in the typed channel before provider IO", async () => {
    mocks.fetch.mockClear();
    const users = vi.fn(async () => ({ rows: [], complete: true }));
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},
                    watch: false,
                    users: { objectType: "User", loadSubset: users },
                    submitAction: async () => {
                        throw new Error("Unexpected action");
                    },
                    decodeObject: (_type, value) => value,
                });
                for (const objectType of ["Issue", "User"]) {
                    const result = yield* Effect.result(
                        loadSubset(backend, objectSubset(objectType, { limit: -1 }))
                    );
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "InvalidRequest", retryable: false },
                    });
                }
            })
        )
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
});

test.each([
    null,
    { edits: { type: "edits" } },
    { edits: { type: "unexpected", edits: [] } },
    { edits: { type: "largeScaleEdits", editedObjectTypes: "Issue" } },
    { edits: { type: "edits", edits: [{ type: "addLink" }] } },
])("malformed action edits fail through the typed channel with an unknown outcome: %j", async (result) => {
    const submitAction = vi.fn(async () => ({ result, attachmentIdMappings: [] })) as unknown as Parameters<
        typeof makeFoundryBackend
    >[0]["submitAction"];
    const outcome = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},
                    watch: false,
                    submitAction,
                    decodeObject: (_type, value) => value,
                });
                return yield* Effect.result(
                    backend.applyAction({ id: "once", name: "edit", parameters: {} })
                );
            })
        )
    );
    expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidResponse", retryable: false, actionOutcome: "unknown" },
    });
    expect(submitAction).toHaveBeenCalledTimes(1);
});

test("a receipt-key decoding failure is a typed unknown outcome, not a defect", async () => {
    const outcome = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},
                    watch: false,
                    submitAction: async () => ({
                        result: {
                            edits: {
                                type: "edits",
                                edits: [{ type: "modifyObject", objectType: "Issue", primaryKey: "one" }],
                            },
                        } as never,
                        attachmentIdMappings: [],
                    }),
                    decodeObject: () => {
                        throw new Error("private decoding details");
                    },
                });
                return yield* Effect.result(
                    backend.applyAction({ id: "once", name: "edit", parameters: {} })
                );
            })
        )
    );
    expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidResponse", actionOutcome: "unknown", retryable: false },
    });
});

test("malformed snapshot keys fail before publishing complete coverage", async () => {
    mocks.fetch.mockResolvedValue([{ title: "no key" }]);
    const outcome = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeFoundryBackend({
                    client: {} as OntologyClient,
                    ir,
                    context: {},
                    watch: false,
                    submitAction: async () => {
                        throw new Error("Unexpected write");
                    },
                    decodeObject: (_type, value) => value,
                });
                return yield* Effect.result(loadSubset(backend, objectSubset("Issue")));
            })
        )
    );
    expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidResponse", retryable: false },
    });
});

function loadSubset(
    backend: import("@party-stack/ontology-backend").OntologyBackendService,
    subset: import("@party-stack/ontology-spec/query").ObjectSubset
) {
    return backend.loadSubset(subset).pipe(
        Effect.flatMap((snapshot) => resolveSubsetSnapshot(ir, subset, snapshot)),
        Effect.map((result) => result.snapshot)
    );
}

test("watch state failures keep Foundry's reason and classify retry behavior", () => {
    const detail = [{ error: "ObjectSetNotSupported", args: [] }];
    const rejected = subscriptionStateError({
        type: "state",
        status: "error",
        reason: { message: "ObjectSetNotSupported", detail },
    });
    expect(rejected).toMatchObject({
        kind: "InvalidRequest",
        retryable: false,
        message: "Foundry rejected the object-set subscription: ObjectSetNotSupported",
    });
    expect(Redacted.value(rejected.cause as Redacted.Redacted<unknown>)).toBe(detail);
    const denied = [
        {
            error: "ApiUsageDenied",
            args: [
                { name: "errorName", value: "ApiUsageDenied" },
                { name: "errorInstanceId", value: "instance" },
                { name: "errorCode", value: "PERMISSION_DENIED" },
            ],
        },
    ];
    expect(
        subscriptionStateError({
            type: "state",
            status: "error",
            reason: { message: "ApiUsageDenied", detail: denied },
        })
    ).toMatchObject({
        kind: "Forbidden",
        retryable: false,
        message: "Foundry rejected the object-set subscription: ApiUsageDenied, PERMISSION_DENIED",
    });
    expect(
        subscriptionStateError({
            type: "state",
            status: "error",
            reason: {
                message: "ObjectTypeNotFound",
                detail: [{ error: "ObjectTypeNotFound", args: [{ name: "errorCode", value: "NOT_FOUND" }] }],
            },
        })
    ).toMatchObject({ kind: "NotFound", retryable: false });
    expect(
        subscriptionStateError({ type: "state", status: "qos", reason: { message: "Reduce load" } })
    ).toMatchObject({ kind: "RateLimited", retryable: true, retryAfterMs: foundryWatchQosRetryMs });
    expect(foundryWatchQosRetryMs).toBeGreaterThanOrEqual(60_000);
    expect(
        subscriptionStateError({ type: "state", status: "closed", reason: { message: "CHANNEL_CLOSED" } })
    ).toMatchObject({
        kind: "Unavailable",
        retryable: true,
        message: "The Foundry object-set subscription closed: CHANNEL_CLOSED",
    });
});
