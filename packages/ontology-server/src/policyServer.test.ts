import { o, executeTransactionMutator, makeStorageOntologyBackend } from "@party-stack/ontology";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica } from "@party-stack/ontology-replica";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import {
    and,
    context,
    eq,
    exists,
    field,
    input,
    literal,
    selectCase,
    selectField,
    sub,
    validatePolicy,
} from "@party-stack/ontology/query";
import { contextPartition } from "@party-stack/ontology/utils";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcTest } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import { projectOntologyBackend } from "./authorization.js";
import { makeOntologyServer } from "./composition.js";
import { OntologyRpcs, ontologyRpcHandlers } from "./rpc.js";
import { connectOntologyHttp } from "./rpcHttp.js";
import type { OntologyIR, TypeDef } from "@party-stack/ontology";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type {
    OwnedReadTransaction,
    OwnedStorageService,
    OwnedBackendService,
} from "@party-stack/ontology-backend/owned";

const property = (name: string, type: TypeDef = o.string({})) => ({ name, displayName: name, type });
function definition(): OntologyIR {
    const target = {
        from: { source: { objectType: "Item" }, binding: "target" },
        where: and(eq(field("target", "id"), input("item")), eq(field("target", "owner"), context("user"))),
        select: [selectField("id", field("target", "id"))],
    };
    return {
        types: [],
        linkTypes: [],
        context: {
            type: o.struct({ fields: [property("user"), property("tenant"), property("role")] }),
            partition: [["tenant"], ["user"]],
        },
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: [
                    property("id"),
                    property("owner"),
                    property("title"),
                    property("secret", o.optional({ type: o.string({}) })),
                    property("personal", o.optional({ type: o.string({}) })),
                ],
            },
        ],
        actionTypes: [
            {
                name: "edit",
                displayName: "Edit",
                parameters: [
                    property("item", o.objectReference({ objectType: "Item" })),
                    property("title"),
                    property("owner"),
                ],
                logic: [],
            },
        ],
        queryFunctionTypes: ["peek", "privileged"].map((name) => ({
            name,
            displayName: name,
            parameters: [property("item", o.objectReference({ objectType: "Item" }))],
            returnType: o.optional({ type: o.string({}) }),
        })),
        policy: {
            read: {
                select: [
                    sub("items", {
                        from: { source: { objectType: "Item" }, binding: "i" },
                        where: eq(field("i", "owner"), context("user")),
                        select: [
                            ...["id", "owner", "title"].map((name) => selectField(name, field("i", name))),
                            selectCase({
                                branches: [
                                    {
                                        condition: eq(context("role"), literal("admin")),
                                        select: [selectField("secret", field("i", "secret"))],
                                    },
                                ],
                            }),
                            selectCase({
                                branches: [
                                    {
                                        condition: eq(field("i", "title"), literal("Personal")),
                                        select: [selectField("personal", field("i", "personal"))],
                                    },
                                ],
                            }),
                        ],
                    }),
                ],
            },
            actions: [
                {
                    actionType: "edit",
                    check: exists(target),
                    bind: [{ parameter: "owner", expression: context("user") }],
                },
            ],
            queryFunctions: [
                { queryFunctionType: "peek", check: exists(target) },
                {
                    queryFunctionType: "privileged",
                    check: exists(target),
                    read: {
                        select: [
                            sub("privateRead", {
                                ...target,
                                select: [
                                    selectField("id", field("target", "id")),
                                    selectField("secret", field("target", "secret")),
                                ],
                            }),
                        ],
                    },
                },
            ],
        },
    };
}
const principal = { user: "alice", tenant: "org", role: "member" };

test("owned checks share the mutation snapshot and handlers only receive their granted read view", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const ir = definition();
            let observed: unknown = "not-run";
            const owned = yield* makeOwnedBackend({
                ir,
                namespace: "atomic-policy",
                tables: yield* Memory.make(),
                mutators: {
                    edit: (tx, request) =>
                        Effect.gen(function* () {
                            const previous = yield* tx.get("Item", String(request.parameters.item));
                            observed = previous?.secret;
                            yield* tx.put("Item", {
                                id: request.parameters.item,
                                owner: request.parameters.owner,
                                title: request.parameters.title,
                                secret: "private",
                            });
                        }),
                },
                queryFunctions: Object.fromEntries(
                    ["peek", "privileged"].map((name) => [
                        name,
                        (tx: OwnedReadTransaction, parameters: Record<string, unknown>) =>
                            tx.get("Item", String(parameters.item)).pipe(Effect.map((row) => row?.secret)),
                    ])
                ),
            });
            yield* owned.storage.transaction((tx) =>
                tx.put("Item", { id: "a", owner: "alice", title: "Old", secret: "private" })
            );
            let revoke = false;
            let preflightReads = 0;
            const publicStorage: OwnedStorageService = {
                ...owned.storage,
                read: (body) => {
                    preflightReads++;
                    return owned.storage.read(body);
                },
            };
            const backend = {
                ...owned,
                storage: publicStorage,
                applyAction: (request) =>
                    Effect.gen(function* () {
                        if (revoke)
                            yield* owned.storage.transaction((tx) =>
                                tx.put("Item", { id: "a", owner: "bob", title: "Old", secret: "private" })
                            );
                        return yield* owned.applyAction(request);
                    }),
            } satisfies OwnedBackendService;
            const view = yield* projectOntologyBackend({ backend, ir, context: principal });
            expect(yield* view.backend.queryFunction("peek", { item: "a" })).toBeUndefined();
            expect(yield* view.backend.queryFunction("privileged", { item: "a" })).toBe("private");
            const action = {
                id: "one",
                name: "edit",
                parameters: { item: "a", title: "New", owner: "tampered" },
            };
            revoke = true;
            const denied = yield* Effect.result(view.backend.applyAction(action));
            expect(denied).toMatchObject({
                _tag: "Failure",
                failure: { kind: "NotFound", actionOutcome: "not-committed" },
            });
            expect(observed).toBe("not-run");
            expect(preflightReads).toBe(0);
            expect((yield* owned.storage.read((tx) => tx.get("Item", "a")))?.title).toBe("Old");
            revoke = false;
            yield* owned.storage.transaction((tx) =>
                tx.put("Item", { id: "a", owner: "alice", title: "Old", secret: "private" })
            );
            expect((yield* view.backend.applyAction(action)).outcome).toBe("committed");
            expect(observed).toBeUndefined();
            yield* owned.storage.transaction((tx) =>
                tx.put("Item", { id: "b", owner: "bob", title: "Bob", secret: "private" })
            );
            const bob = yield* projectOntologyBackend({
                backend,
                ir,
                context: { ...principal, user: "bob" },
            });
            expect(
                (yield* bob.backend.applyAction({
                    ...action,
                    parameters: { item: "b", title: "Bob changed" },
                })).outcome
            ).toBe("committed");
            expect((yield* owned.storage.read((tx) => tx.get("Item", "b")))?.title).toBe("Bob changed");

            expect(yield* owned.storage.read((tx) => tx.get("Item", "a"))).toMatchObject({
                owner: "alice",
                title: "New",
            });
        })
    );
});

test("generated action updates preserve unread properties and untouched nested fields", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const ir = definition();
            ir.objectTypes[0]!.properties.push(
                property("profile", o.struct({ fields: [property("visible"), property("hidden")] }))
            );
            const root = ir.policy!.read.select[0]!;
            if (root.kind === "sub")
                root.value.query.select = root.value.query.select.filter(
                    (s) => s.kind !== "field" || s.value.name !== "owner"
                );
            ir.actionTypes[0]!.logic = [
                o.ActionLogicStep.updateObject({
                    object: { name: "item" },
                    values: [
                        { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
                        {
                            property: ["profile", "visible"],
                            value: o.Expression.inputReference({ name: "title" }),
                        },
                    ],
                }),
            ];
            const owned = yield* makeOwnedBackend({
                ir,
                namespace: "private-field-updates",
                tables: yield* Memory.make(),
                mutators: {
                    edit: (tx, request) =>
                        executeTransactionMutator({
                            ir,
                            tx,
                            name: request.name,
                            operationId: request.id,
                            parameters: request.parameters,
                            context: principal,
                        }).pipe(Effect.asVoid),
                },
            });
            yield* owned.storage.transaction((tx) =>
                tx.put("Item", {
                    id: "a",
                    owner: "alice",
                    title: "Old",
                    secret: "private",
                    profile: { visible: "old", hidden: "keep" },
                })
            );
            const view = yield* projectOntologyBackend({ backend: owned, ir, context: principal });
            yield* view.backend.applyAction({
                id: "edit",
                name: "edit",
                parameters: { item: "a", title: "New" },
            });
            expect(yield* owned.storage.read((tx) => tx.get("Item", "a"))).toEqual({
                id: "a",
                owner: "alice",
                title: "New",
                secret: "private",
                profile: { visible: "New", hidden: "keep" },
            });
            expect((yield* view.backend.loadSubset({ objectType: "Item" })).rows[0]?.value).toEqual({
                id: "a",
                title: "New",
            });
        })
    );
});

test("a shared native backend uses each invocation's trusted context without retaining it", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const ir = definition();
            ir.actionTypes[0]!.logic = [
                o.ActionLogicStep.updateObject({
                    object: { name: "item" },
                    values: [
                        { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
                        { property: ["owner"], value: o.Expression.contextReference({ name: "user" }) },
                    ],
                }),
            ];
            ir.queryFunctionTypes.push({
                name: "actor",
                displayName: "Actor",
                parameters: [],
                returnType: o.string({}),
            });
            ir.policy!.queryFunctions!.push({ queryFunctionType: "actor", check: literal(true) });
            const tables = yield* Memory.make();
            const blobs = yield* makeBlobStorage({
                namespace: "shared-context",
                tables,
                mode: "authoritative",
                bytes: {
                    read: () => Effect.succeed(undefined),
                    write: () => Effect.void,
                    delete: () => Effect.void,
                },
            });
            const owned = yield* makeStorageOntologyBackend({
                ir,
                namespace: "shared-context",
                tables,
                blobs,
                context: { user: "service", tenant: "org", role: "service" },
                queryFunctions: { actor: ({ context }) => context.user },
            });
            yield* owned.storage.transaction((tx) =>
                Effect.gen(function* () {
                    for (const user of ["alice", "bob"])
                        yield* tx.put("Item", { id: user, owner: user, title: "Old", secret: "private" });
                })
            );
            for (const user of ["alice", "bob"]) {
                const view = yield* makeOntologyServer({
                    kind: "owned",
                    backend: owned,
                    ir,
                    context: { ...principal, user },
                });
                expect(yield* view.backend.queryFunction("actor", {})).toBe(user);
                yield* view.backend.applyAction({
                    id: "same-operation-id",
                    name: "edit",
                    parameters: { item: user, title: "New" },
                });
                expect((yield* owned.storage.read((tx) => tx.get("Item", user)))?.owner).toBe(user);
            }
            expect(yield* owned.queryFunction("actor", {})).toBe("service");
        }).pipe(Effect.scoped)
    );
});

test("projected discovery, finite queries and private protocol boundaries use the same IR policy", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition();
                const owned = yield* makeOwnedBackend({
                    ir,
                    namespace: "policy-description",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* owned.storage.transaction((tx) =>
                    tx.put("Item", {
                        id: "a",
                        owner: "alice",
                        title: "Personal",
                        secret: "private",
                        personal: "allowed",
                    })
                );
                const view = yield* projectOntologyBackend({
                    backend: owned,
                    ir,
                    context: principal,
                });
                expect(view.ir.policy).toBeUndefined();
                expect(view.ir.context?.type).toEqual(ir.context?.type);
                expect(view.ir.context?.partition).toEqual(ir.context?.partition);
                expect(view.ir.objectTypes[0]?.properties.find((p) => p.name === "secret")).toBeUndefined();
                expect(view.ir.objectTypes[0]?.properties.find((p) => p.name === "personal")?.type.kind).toBe(
                    "optional"
                );
                expect(view.ir.actionTypes[0]?.parameters.map((p) => p.name)).toEqual(["item", "title"]);
                expect(view.backend.changes).toBeUndefined();
                expect(view.backend.subscribeSelection).toBeUndefined();
                const other = yield* projectOntologyBackend({
                    backend: owned,
                    ir,
                    context: { ...principal, tenant: "other" },
                });
                expect(contextPartition(other.ir, other.context)).not.toBe(
                    contextPartition(view.ir, view.context)
                );
                const admin = yield* projectOntologyBackend({
                    backend: owned,
                    ir,
                    context: { ...principal, role: "admin" },
                });
                expect(admin.ir.objectTypes[0]?.properties.some((p) => p.name === "secret")).toBe(true);
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(ontologyRpcHandlers(view))
                );
                const description = yield* client.Describe();
                expect(description.ir).toEqual(view.ir);
                expect(description.context).toEqual(principal);
                expect(description.queries).toBe(true);
                expect(description.changes).toBe(false);
                const answer = yield* client.Query({
                    document: {
                        select: [
                            sub("items", {
                                from: { source: { objectType: "Item" }, binding: "item" },
                                select: [selectField("title", field("item", "title"))],
                            }),
                        ],
                    },
                });
                expect(answer).toEqual({ items: [{ title: "Personal" }] });
                expect(yield* Effect.result(client.PullChanges({}))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotFound" },
                });
                expect(yield* Effect.result(client.DeleteLocalData())).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotFound" },
                });
            })
        )
    );
});

test("an incomplete provider subset cannot establish an authorization grant or absence", async () => {
    const backend: OntologyBackendService = {
        name: "partial",
        sourceId: "partial",
        supportsIdempotency: false,
        loadSubset: () => Effect.succeed({ rows: [], complete: false }),
        applyAction: () => Effect.die("Unexpected write"),
        queryFunction: () => Effect.void,
    };
    const view = await Effect.runPromise(
        projectOntologyBackend({ backend, ir: definition(), context: principal })
    );
    expect(
        await Effect.runPromise(Effect.result(view.backend.loadSubset({ objectType: "Item" })))
    ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse" } });
});

test("HTTP cached-proxy views guard warm shared data independently for each principal", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition();
                const owned = yield* makeOwnedBackend({
                    ir,
                    namespace: "cached-policy-source",
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* owned.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("Item", {
                            id: "a",
                            owner: "alice",
                            title: "Alice",
                            secret: "alice-secret",
                        });
                        yield* tx.put("Item", { id: "b", owner: "bob", title: "Bob", secret: "bob-secret" });
                    })
                );
                const upstream: OntologyBackendService = {
                    name: owned.name,
                    sourceId: owned.sourceId,
                    supportsIdempotency: true,
                    loadSubset: owned.loadSubset,
                    applyAction: owned.applyAction,
                    queryFunction: owned.queryFunction,
                };
                const cache = yield* makeReplica({
                    ir,
                    namespace: "shared-private-cache",
                    tables: yield* Memory.make(),
                    backend: upstream,
                    startSync: false,
                    execute: () => Effect.void,
                });
                yield* cache.demand({ objectType: "Item" });
                yield* cache.syncOnce;
                expect((yield* cache.get("Item", "b"))?.secret).toBe("bob-secret");
                const partitions: string[] = [];
                for (const user of ["alice", "bob"]) {
                    const server = yield* makeOntologyServer({
                        kind: "cached-proxy",
                        backend: upstream,
                        cache,
                        ir,
                        context: { ...principal, user },
                    });
                    yield* Effect.gen(function* () {
                        const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                        partitions.push(contextPartition(connection.ir!, connection.context!));
                        expect(connection.context?.user).toBe(user);
                        expect(connection.backend.changes).toBeUndefined();
                        const rows = yield* connection.backend.loadSubset({ objectType: "Item" });
                        expect(rows.rows.map((r) => r.value)).toEqual([
                            {
                                id: user === "alice" ? "a" : "b",
                                owner: user,
                                title: user === "alice" ? "Alice" : "Bob",
                            },
                        ]);
                        const result = yield* connection.operations.query({
                            select: [
                                sub("items", {
                                    from: { source: { objectType: "Item" }, binding: "item" },
                                    select: [selectField("title", field("item", "title"))],
                                }),
                            ],
                        });
                        expect(result).toEqual({ items: [{ title: user === "alice" ? "Alice" : "Bob" }] });
                    }).pipe(
                        Effect.provide(FetchHttpClient.layer),
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            server.handleRequest(new Request(input, init))
                        )
                    );
                }
                expect(partitions[0]).not.toBe(partitions[1]);
            })
        )
    );
});

test("a token gateway replaces upstream context and policy, strips bindings and isolates a shared cache", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const object = (name: string, fields: string[]) => ({
                    name,
                    displayName: name,
                    pluralDisplayName: `${name}s`,
                    primaryKey: "id",
                    properties: ["id", ...fields].map((name) => property(name)),
                });
                const sourceIR: OntologyIR = {
                    types: [],
                    linkTypes: [],
                    queryFunctionTypes: [],
                    context: { type: o.struct({ fields: [property("user")] }) },
                    objectTypes: [
                        object("PostApproval", ["person"]),
                        object("Person", ["name", "ssn"]),
                        object("Bid", ["approval", "title", "createdBy"]),
                        object("Post", ["name"]),
                    ],
                    actionTypes: [
                        {
                            name: "submitBid",
                            displayName: "Submit bid",
                            parameters: [
                                property("approval", o.objectReference({ objectType: "PostApproval" })),
                                property("title"),
                                {
                                    ...property("note", o.optional({ type: o.string({}) })),
                                    defaultValue: context("user"),
                                },
                            ],
                            logic: [
                                o.ActionLogicStep.createObject({
                                    objectType: "Bid",
                                    values: [
                                        { property: ["id"], value: literal("new-bid") },
                                        { property: ["approval"], value: input("approval") },
                                        { property: ["title"], value: input("title") },
                                        { property: ["createdBy"], value: context("user") },
                                    ],
                                }),
                            ],
                        },
                    ],
                };
                const received: Record<string, unknown>[] = [];
                const owned = yield* makeOwnedBackend({
                    ir: sourceIR,
                    namespace: "token-gateway-source",
                    tables: yield* Memory.make(),
                    mutators: {
                        submitBid: (_tx, request) =>
                            Effect.sync(() => {
                                received.push(request.parameters);
                            }),
                    },
                });
                yield* owned.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        for (const id of ["a", "b"]) {
                            yield* tx.put("PostApproval", { id, person: `person-${id}` });
                            yield* tx.put("Person", {
                                id: `person-${id}`,
                                name: `Person ${id}`,
                                ssn: "secret",
                            });
                            yield* tx.put("Bid", {
                                id: `bid-${id}`,
                                approval: id,
                                title: `Bid ${id}`,
                                createdBy: "service",
                            });
                        }
                        yield* tx.put("Post", { id: "anywhere", name: "Anywhere" });
                    })
                );
                const upstream: OntologyBackendService = {
                    name: owned.name,
                    sourceId: owned.sourceId,
                    supportsIdempotency: true,
                    loadSubset: owned.loadSubset,
                    applyAction: owned.applyAction,
                    queryFunction: owned.queryFunction,
                };
                const cache = yield* makeReplica({
                    ir: sourceIR,
                    namespace: "token-gateway-cache",
                    tables: yield* Memory.make(),
                    backend: upstream,
                    startSync: false,
                    execute: () => Effect.void,
                });
                for (const type of sourceIR.objectTypes) yield* cache.demand({ objectType: type.name });
                yield* cache.syncOnce;
                const fields = (binding: string, names: string[]) =>
                    names.map((name) => selectField(name, field(binding, name)));
                const tokenIR: OntologyIR = {
                    ...sourceIR,
                    context: {
                        type: o.struct({
                            fields: [property("approval", o.objectReference({ objectType: "PostApproval" }))],
                        }),
                        partition: [["approval"]],
                    },
                    policy: {
                        read: {
                            select: [
                                sub("approval", {
                                    from: { source: { objectType: "PostApproval" }, binding: "a" },
                                    where: eq(field("a", "id"), context("approval")),
                                    select: [
                                        ...fields("a", ["id", "person"]),
                                        sub(
                                            "personDetails",
                                            {
                                                from: { source: { objectType: "Person" }, binding: "p" },
                                                where: eq(field("p", "id"), field("a", "person")),
                                                select: fields("p", ["id", "name"]),
                                            },
                                            "one"
                                        ),
                                        sub("bids", {
                                            from: { source: { objectType: "Bid" }, binding: "b" },
                                            where: eq(field("b", "approval"), field("a", "id")),
                                            select: fields("b", ["id", "approval", "title"]),
                                        }),
                                    ],
                                }),
                                sub("posts", {
                                    from: { source: { objectType: "Post" }, binding: "p" },
                                    select: fields("p", ["id", "name"]),
                                }),
                            ],
                        },
                        actions: [
                            {
                                actionType: "submitBid",
                                check: literal(true),
                                bind: [{ parameter: "approval", expression: context("approval") }],
                            },
                        ],
                    },
                };
                expect(validatePolicy(tokenIR)).toEqual([]);
                for (const approval of ["a", "b"]) {
                    const bound = { approval };
                    const server = yield* makeOntologyServer({
                        kind: "cached-proxy",
                        backend: upstream,
                        cache,
                        ir: tokenIR,
                        context: bound,
                    });
                    // Mutating application-owned configuration cannot change an authenticated binding.
                    bound.approval = approval === "a" ? "b" : "a";
                    yield* Effect.gen(function* () {
                        const client = yield* connectOntologyHttp({ url: "https://gateway.test/rpc" });
                        expect(client.context).toEqual({ approval });
                        expect(client.ir?.context).toEqual(tokenIR.context);
                        const action = client.ir!.actionTypes[0]!;
                        expect(action.parameters.map((p) => p.name)).toEqual(["title", "note"]);
                        expect(action.parameters[1]!.defaultValue).toBeUndefined();
                        expect(action.logic).toEqual([]);
                        expect(
                            (yield* client.backend.loadSubset({ objectType: "PostApproval" })).rows.map(
                                (row) => row.key
                            )
                        ).toEqual([approval]);
                        expect(
                            (yield* client.backend.loadSubset({ objectType: "Person" })).rows.map(
                                (row) => row.value
                            )
                        ).toEqual([{ id: `person-${approval}`, name: `Person ${approval}` }]);
                        expect(
                            (yield* client.backend.loadSubset({ objectType: "Bid" })).rows.map(
                                (row) => row.key
                            )
                        ).toEqual([`bid-${approval}`]);
                        expect(
                            (yield* client.backend.loadSubset({ objectType: "Post" })).rows.map(
                                (row) => row.key
                            )
                        ).toEqual(["anywhere"]);
                        yield* client.backend.applyAction({
                            id: `submission-${approval}`,
                            name: "submitBid",
                            parameters: { approval: "spoofed", title: "A bid" },
                        });
                        expect(received.at(-1)).toEqual({ approval, title: "A bid" });
                    }).pipe(
                        Effect.provide(FetchHttpClient.layer),
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            server.handleRequest(new Request(input, init))
                        )
                    );
                }
            })
        )
    );
});

test("ontology drift in policy fields, bound parameters or their types fails closed before provider access", async () => {
    let providerCalls = 0;
    const backend: OntologyBackendService = {
        name: "drift",
        sourceId: "drift",
        supportsIdempotency: false,
        loadSubset: () =>
            Effect.sync(() => {
                providerCalls++;
                return { complete: true, rows: [] };
            }),
        applyAction: () =>
            Effect.sync(() => {
                providerCalls++;
                return { operationId: "unexpected", outcome: "committed" as const };
            }),
        queryFunction: () =>
            Effect.sync(() => {
                providerCalls++;
            }),
    };
    const changedField = definition();
    changedField.objectTypes[0]!.properties = changedField.objectTypes[0]!.properties.filter(
        (p) => p.name !== "owner"
    );
    const removedParameter = definition();
    removedParameter.actionTypes[0]!.parameters = removedParameter.actionTypes[0]!.parameters.filter(
        (p) => p.name !== "owner"
    );
    const changedParameter = definition();
    changedParameter.actionTypes[0]!.parameters.find((p) => p.name === "owner")!.type = o.integer({});
    for (const ir of [changedField, removedParameter, changedParameter]) {
        expect(
            await Effect.runPromise(
                Effect.result(projectOntologyBackend({ backend, ir, context: principal }))
            )
        ).toMatchObject({
            _tag: "Failure",
            failure: { kind: "InvalidConfiguration" },
        });
    }
    expect(providerCalls).toBe(0);
});
