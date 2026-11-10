import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { ontologyDefinitionContractSignature } from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcTest } from "effect/rpc";
import { expect, test, vi } from "vite-plus/test";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import { makeOntologyHttpClient, makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologyDescription, OntologyRpcClient } from "./rpc.js";
import type { DeliveryFrame } from "@party-stack/ontology-backend/delivery";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [
        {
            name: "edit",
            displayName: "Edit",
            logic: [],
            parameters: [{ name: "file", displayName: "File", type: o.attachment({}) }],
        },
    ],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
// This fixture overrides only Describe's default response mode, as used by the client factory.
const withDescribe = (
    raw: OntologyRpcClient,
    describe: () => Effect.Effect<OntologyDescription, BackendError>
): OntologyRpcClient => ({ ...raw, Describe: describe as OntologyRpcClient["Describe"] });

const setup = Effect.fnUntraced(function* (readError?: BackendError) {
    const loads = vi.fn(() =>
        Effect.suspend(() =>
            readError
                ? Effect.fail(readError)
                : Effect.succeed({ complete: true, rows: [{ key: "a", value: { id: "a" } }] })
        )
    );
    const actions = vi.fn((request: { id: string }) =>
        Effect.succeed({ operationId: request.id, outcome: "committed" as const })
    );
    const watches = vi.fn(() => Effect.succeed(Stream.make(undefined)));
    const binding = { sourceId: "saved-source", context: { account: "a" } as Record<string, unknown> };
    const native = makeOntologyBackend({
        ir,
        name: "test",
        sourceId: binding.sourceId,
        supportsIdempotency: true,
        loadSubset: loads,
        applyAction: actions,
        queryFunction: () => Effect.succeed("ok"),
        watchSubset: watches,
    });
    const backend = {
        ...native,
        get sourceId() {
            return binding.sourceId;
        },
    };
    const options = {
        enableRealtime: true,
        backend,
        ir,
        get context() {
            return binding.context;
        },
        authorize: () => Effect.void,
    };
    const raw = yield* RpcTest.makeClient(OntologyRpcs).pipe(Effect.provide(ontologyRpcHandlers(options)));
    const description = yield* raw.Describe();
    return { raw, description, backend, options, binding, loads, actions, watches };
});

test.each([
    ["committed", "SchemaMismatch"],
    ["speculative", "SchemaMismatch"],
    ["committed", "SourceMismatch"],
    ["speculative", "SourceMismatch"],
] as const)("%s delivery reports %s before any rows are exposed", async (replication, expectedKind) => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const changed = structuredClone(ir);
                changed.objectTypes[0]!.properties.push({
                    name: "count",
                    displayName: "Count",
                    type: o.integer({}),
                });
                const metadataHash = yield* digestBytes({
                    type: "application/json",
                    stream: Stream.make(
                        new TextEncoder().encode(ontologyDefinitionContractSignature(changed))
                    ),
                });
                const frame: DeliveryFrame = {
                    streamId: "test",
                    sequence: 1,
                    previous: 0,
                    part: 0,
                    kind: "snapshot",
                    changes: [],
                    end: true,
                    metadata: {
                        sourceId:
                            expectedKind === "SourceMismatch"
                                ? "different-source"
                                : fixture.description.sourceId,
                        schemaHash: metadataHash,
                        generation: 1,
                        revision: 1,
                        coverage: [],
                    },
                };
                const description = {
                    ...fixture.description,
                    replication,
                    delivery: true,
                    stateDelivery: true,
                };
                const describe = vi.fn(() => Effect.succeed({ ...description, ir: changed }));
                const raw = withDescribe(fixture.raw, describe);
                const notified = yield* Deferred.make<BackendError>();
                const client = yield* makeOntologyProtocolClient(
                    {
                        ...raw,
                        SubscribeSelection: (() =>
                            Stream.make(frame)) as OntologyRpcClient["SubscribeSelection"],
                        SubscribeState: (() => Stream.make(frame)) as OntologyRpcClient["SubscribeState"],
                    },
                    {
                        description,
                        onIncompatible: (error) => Deferred.succeed(notified, error).pipe(Effect.asVoid),
                    }
                );
                const delivery =
                    client.replication.kind === "speculative"
                        ? yield* client.replication.source.subscribe!(
                              {
                                  client: {
                                      sourceId: description.sourceId,
                                      clientId: "test",
                                      resumeKey: "test",
                                  },
                                  connectionId: "test",
                              },
                              { generation: 1, selection: { subsets: [], actionIds: [] } }
                          )
                        : yield* client.backend.subscribeSelection!({ subsets: [] });
                expect(yield* Effect.result(Stream.runCollect(delivery.frames))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: expectedKind },
                });
                expect((yield* Deferred.await(notified)).kind).toBe(expectedKind);
                expect(yield* client.definition.get).toMatchObject({ status: "incompatible" });
                if (expectedKind === "SourceMismatch") expect(describe).not.toHaveBeenCalled();
            })
        )
    );
});

test("retained construction and ordinary operations never require a Describe roundtrip", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const fresh = yield* Deferred.make<OntologyDescription, BackendError>();
                const started = yield* Deferred.make<void>();
                const describe = vi.fn(() =>
                    Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(fresh)))
                );
                const validate = vi.fn(() => Effect.void);
                const client = yield* makeOntologyProtocolClient(withDescribe(fixture.raw, describe), {
                    description: fixture.description,
                    validate,
                });
                expect(describe).not.toHaveBeenCalled();
                expect(client.description).toEqual(fixture.description);
                expect(client.description.ir).not.toBe(fixture.description.ir);
                expect(yield* client.definition.get).toEqual({ status: "retained", refreshing: false });
                const refresh = yield* Effect.forkScoped(client.definition.refresh);
                yield* Deferred.await(started);
                expect((yield* client.backend.loadSubset(objectSubset("Item"))).rows).toHaveLength(1);
                expect(
                    yield* client.backend.applyAction({ id: "one", name: "edit", parameters: {} })
                ).toMatchObject({ operationId: "one" });
                yield* Stream.runDrain(Stream.unwrap(client.backend.watchSubset!(objectSubset("Item"))!));
                expect(fixture.loads).toHaveBeenCalledOnce();
                expect(fixture.actions).toHaveBeenCalledOnce();
                expect(fixture.watches).toHaveBeenCalledOnce();
                expect(validate).not.toHaveBeenCalled();
                yield* Deferred.succeed(fresh, fixture.description);
                yield* Fiber.join(refresh);
                expect(validate).toHaveBeenCalledOnce();
                expect(yield* client.definition.get).toEqual({ status: "current", refreshing: false });
            })
        )
    );
});

test("explicit refresh coalesces concurrent attempts and retries transient failures without polling", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const error = new BackendError({
                    operation: "describe",
                    kind: "Unavailable",
                    retryable: true,
                    message: "Offline",
                });
                const next = yield* Deferred.make<OntologyDescription, BackendError>();
                const started = yield* Deferred.make<void>();
                let attempts = 0;
                const describe = vi.fn(() =>
                    Effect.suspend(() =>
                        ++attempts === 1
                            ? Effect.fail(error)
                            : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(next)))
                    )
                );
                const client = yield* makeOntologyProtocolClient(withDescribe(fixture.raw, describe), {
                    description: fixture.description,
                });
                expect(yield* Effect.result(client.definition.refresh)).toMatchObject({
                    _tag: "Failure",
                    failure: error,
                });
                expect(yield* client.definition.get).toMatchObject({
                    status: "retained",
                    refreshing: false,
                    error,
                });
                yield* client.backend.loadSubset(objectSubset("Item"));
                expect(describe).toHaveBeenCalledOnce();
                const first = yield* Effect.forkScoped(client.definition.refresh);
                yield* Deferred.await(started);
                const second = yield* Effect.forkScoped(client.definition.refresh);
                yield* Effect.yieldNow;
                expect(describe).toHaveBeenCalledTimes(2);
                yield* Deferred.succeed(next, fixture.description);
                yield* Fiber.join(first);
                yield* Fiber.join(second);
                expect(describe).toHaveBeenCalledTimes(2);
                expect(yield* client.definition.get).toEqual({ status: "current", refreshing: false });
            })
        )
    );
});

test.each(["source", "context", "protocol"] as const)(
    "refresh rejects a changed %s binding before definition adoption",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fixture = yield* setup();
                    const fresh: OntologyDescription = {
                        ...fixture.description,
                        ...(kind === "source"
                            ? { sourceId: "another-source" }
                            : kind === "context"
                              ? { context: { account: "another-account" } }
                              : { supportsIdempotency: false }),
                    };
                    const validate = vi.fn(() => Effect.void);
                    const notified = yield* Deferred.make<BackendError>();
                    const client = yield* makeOntologyProtocolClient(
                        withDescribe(fixture.raw, () => Effect.succeed(fresh)),
                        {
                            description: fixture.description,
                            validate,
                            onIncompatible: (error) => Deferred.succeed(notified, error).pipe(Effect.asVoid),
                        }
                    );
                    const expected = kind === "protocol" ? "SchemaMismatch" : "SourceMismatch";
                    expect(yield* Effect.result(client.definition.refresh)).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: expected, retryable: false },
                    });
                    expect((yield* Deferred.await(notified)).kind).toBe(expected);
                    expect(validate).not.toHaveBeenCalled();
                    expect(client.description).toEqual(fixture.description);
                    expect(yield* client.definition.get).toMatchObject({
                        status: "incompatible",
                        refreshing: false,
                        error: { kind: expected },
                    });
                })
            )
        );
    }
);

test("incompatible definition errors are observable without gating subsequent ordinary operations", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const fresh = { ...fixture.description, definitionHash: "new-definition" };
                const error = new BackendError({
                    operation: "definition",
                    kind: "SchemaMismatch",
                    retryable: false,
                    message: "Upgrade required",
                });
                const validate = vi.fn(() => Effect.fail(error));
                const client = yield* makeOntologyProtocolClient(
                    withDescribe(fixture.raw, () => Effect.succeed(fresh)),
                    { description: fixture.description, validate }
                );
                expect(yield* Effect.result(client.definition.refresh)).toMatchObject({
                    _tag: "Failure",
                    failure: error,
                });
                expect(client.description.definitionHash).toBe(fixture.description.definitionHash);
                expect(validate).toHaveBeenCalledWith(fresh);
                yield* client.backend.loadSubset(objectSubset("Item"));
                expect(fixture.loads).toHaveBeenCalledOnce();
            })
        )
    );
});

test("closing a client scope interrupts its refresh without closing the borrowed transport", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const started = yield* Deferred.make<void>();
                const stopped = yield* Deferred.make<void>();
                const scope = yield* Scope.make();
                const Describe: OntologyRpcClient["Describe"] = () =>
                    Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.ensuring(Deferred.succeed(stopped, undefined))
                    );
                const client = yield* Scope.provide(
                    makeOntologyProtocolClient(
                        { ...fixture.raw, Describe },
                        { description: fixture.description }
                    ),
                    scope
                );
                const pending = yield* Effect.forkScoped(client.definition.refresh);
                yield* Deferred.await(started);
                yield* Scope.close(scope, Exit.void);
                yield* Deferred.await(stopped);
                expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
                yield* fixture.raw.LoadSubset(objectSubset("Item"));
                expect(fixture.loads).toHaveBeenCalledOnce();
            })
        )
    );
});

test("a retained description without IR is rejected before any remote attempt", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const describe = vi.fn(() => Effect.succeed(fixture.description));
                expect(
                    yield* Effect.result(
                        makeOntologyProtocolClient(withDescribe(fixture.raw, describe), {
                            description: { ...fixture.description, ir: undefined },
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
                expect(describe).not.toHaveBeenCalled();
            })
        )
    );
});

test.each(["source", "context"] as const)(
    "ordinary requests fence changed %s without a preflight, including first-online clients",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fixture = yield* setup();
                    const describe = vi.fn(fixture.raw.Describe);
                    const notified = yield* Deferred.make<BackendError>();
                    const client = yield* makeOntologyProtocolClient(withDescribe(fixture.raw, describe), {
                        onIncompatible: (error) => Deferred.succeed(notified, error).pipe(Effect.asVoid),
                    });
                    expect(describe).toHaveBeenCalledOnce();
                    if (kind === "source") fixture.binding.sourceId = "new-source";
                    else fixture.binding.context = { account: "new-account" };
                    expect(
                        yield* Effect.result(
                            client.backend.applyAction({ id: "one", name: "edit", parameters: {} })
                        )
                    ).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "SourceMismatch", actionOutcome: "not-committed" },
                    });
                    expect(fixture.actions).not.toHaveBeenCalled();
                    expect((yield* Deferred.await(notified)).kind).toBe("SourceMismatch");
                    expect(
                        yield* Effect.result(client.backend.loadSubset(objectSubset("Item")))
                    ).toMatchObject({ _tag: "Failure", failure: { kind: "SourceMismatch" } });
                    expect(fixture.loads).not.toHaveBeenCalled();
                })
            )
        );
    }
);

test("HTTP streamed uploads and multipart actions obey the same source fence", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const stage = vi.fn((value: { id: string }) => Effect.succeed(value));
                const backend = {
                    ...fixture.backend,
                    get sourceId() {
                        return fixture.binding.sourceId;
                    },
                    attachments: {
                        stage,
                        read: () => Effect.succeed(new Blob([])),
                        metadata: () => Effect.succeed({}),
                    },
                };
                const handler = yield* makeOntologyHttpHandler({
                    ...fixture.options,
                    backend,
                });
                const notified = yield* Deferred.make<BackendError>();
                yield* Effect.gen(function* () {
                    const transport = yield* makeOntologyHttpClient({ url: "https://ontology.test/rpc" });
                    const client = yield* transport.ontology(undefined, {
                        description: { ...fixture.description, attachments: { stage: true } },
                        onIncompatible: (error) => Deferred.succeed(notified, error).pipe(Effect.asVoid),
                    });
                    fixture.binding.sourceId = "new-source";
                    expect(
                        yield* Effect.result(
                            client.operations.attachments.create(new Blob(["bytes"]), { id: "file" })
                        )
                    ).toMatchObject({ _tag: "Failure", failure: { kind: "SourceMismatch" } });
                    expect(
                        yield* Effect.result(
                            client.backend.applyAction({
                                id: "multipart",
                                name: "edit",
                                parameters: { file: { id: "file" } },
                                attachmentUploads: [
                                    { attachment: { id: "file" }, blob: new Blob(["bytes"]) },
                                ],
                            })
                        )
                    ).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "SourceMismatch", actionOutcome: "not-committed" },
                    });
                    expect((yield* Deferred.await(notified)).kind).toBe("SourceMismatch");
                    expect(stage).not.toHaveBeenCalled();
                    expect(fixture.actions).not.toHaveBeenCalled();
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handler(new Request(input, init))
                    )
                );
            })
        )
    );
});

test("presentation-only definition refresh succeeds without replacing the accepted capability snapshot", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                const fresh = {
                    ...fixture.description,
                    definitionHash: "new-presentation",
                    ir: {
                        ...ir,
                        objectTypes: ir.objectTypes.map((object) => ({ ...object, displayName: "Renamed" })),
                    },
                };
                const client = yield* makeOntologyProtocolClient(
                    withDescribe(fixture.raw, () => Effect.succeed(fresh)),
                    { description: fixture.description }
                );
                expect(yield* client.definition.refresh).toEqual(fresh);
                expect(yield* client.definition.get).toEqual({ status: "current", refreshing: false });
                expect(client.description).toEqual(fixture.description);
            })
        )
    );
});

test("context expectation encoding is canonical and supports non-ASCII values", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* setup();
                fixture.binding.context = { account: "élise", region: "日本" };
                const client = yield* makeOntologyProtocolClient(fixture.raw);
                fixture.binding.context = { region: "日本", account: "élise" };
                yield* client.backend.loadSubset(objectSubset("Item"));
                expect(fixture.loads).toHaveBeenCalledOnce();
            })
        )
    );
});

test.each(["SchemaMismatch", "InvalidRequest", "Unavailable"] as const)(
    "only a typed incompatible operation error triggers definition refresh (%s)",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const error = new BackendError({
                        operation: "load",
                        kind,
                        retryable: kind === "Unavailable",
                        message: "Read failed",
                    });
                    const fixture = yield* setup(error);
                    const started = yield* Deferred.make<void>();
                    const describe = vi.fn(() =>
                        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                    );
                    const notify = vi.fn(() => Effect.void);
                    const client = yield* makeOntologyProtocolClient(withDescribe(fixture.raw, describe), {
                        description: fixture.description,
                        onIncompatible: notify,
                    });
                    expect(
                        yield* Effect.result(client.backend.loadSubset(objectSubset("Item")))
                    ).toMatchObject({ _tag: "Failure", failure: { kind } });
                    if (kind === "SchemaMismatch") {
                        yield* Deferred.await(started);
                        expect(describe).toHaveBeenCalledOnce();
                        expect(notify).toHaveBeenCalledOnce();
                        expect(yield* client.definition.get).toMatchObject({
                            status: "incompatible",
                            error: { kind },
                        });
                    } else {
                        yield* Effect.yieldNow;
                        expect(describe).not.toHaveBeenCalled();
                        expect(notify).not.toHaveBeenCalled();
                    }
                })
            )
        );
    }
);
