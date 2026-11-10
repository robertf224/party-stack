import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplica } from "../../ontology-replica/lib/service.js";
import { makeOntologyServer } from "./routing.js";
import { makeOntologyLocalClient } from "./rpcLocal.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ByteInput } from "@party-stack/ontology-storage/blobs";

const property = (name: string) => ({ name, displayName: name, type: o.string({}) });
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [property("id"), property("owner"), property("title")],
        },
    ],
    actionTypes: [
        {
            name: "edit",
            displayName: "Edit",
            parameters: [
                { name: "item", displayName: "Item", type: o.objectReference({ objectType: "Item" }) },
                property("title"),
            ],
            logic: [],
        },
    ],
};
const edit = (tx: OwnedTransaction, { parameters }: ActionRequest) =>
    tx.patch("Item", parameters.item as string, [{ path: ["title"], value: parameters.title }]);
const owned = Effect.fnUntraced(function* (definition = ir) {
    const backend = yield* makeOwnedBackend({
        namespace: "local-rpc-owned",
        ir: definition,
        tables: yield* Memory.make(),
        mutators: { edit },
    });
    yield* backend.storage.transaction((tx) =>
        Effect.all(
            [
                tx.put("Item", { id: "a", owner: "alice", title: "A" }),
                tx.put("Item", { id: "b", owner: "bob", title: "B" }),
            ],
            { discard: true }
        )
    );
    return backend;
});

test("local selection uses ordinary routes, context and policy checks", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const definition: OntologyIR = {
                    ...ir,
                    context: { type: o.struct({ fields: [property("userId")] }), partition: [["userId"]] },
                    policy: {
                        objects: {
                            select: [
                                q.sub("items", {
                                    from: { source: { objectType: "Item" }, binding: "i" },
                                    where: q.eq(q.field("i", "owner"), q.context("userId")),
                                    select: ["id", "owner", "title"].map((name) =>
                                        q.selectField(name, q.field("i", name))
                                    ),
                                }),
                            ],
                        },
                        actions: [
                            {
                                actionType: "edit",
                                check: q.exists({
                                    from: { source: { objectType: "Item" }, binding: "i" },
                                    where: q.and(
                                        q.eq(q.field("i", "id"), q.input("item")),
                                        q.eq(q.field("i", "owner"), q.context("userId"))
                                    ),
                                    select: [],
                                }),
                            },
                        ],
                    },
                };
                const backend = yield* owned(definition);
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    routes: {
                        alice: { kind: "owned", ir: definition, backend, context: { userId: "alice" } },
                        bob: { kind: "owned", ir: definition, backend, context: { userId: "bob" } },
                    },
                });
                const local = yield* makeOntologyLocalClient(server, { ontology: "alice" });
                const alice = yield* local.ontology();
                const bob = yield* local.ontology("bob");
                expect(alice.context).toEqual({ userId: "alice" });
                expect(bob.context).toEqual({ userId: "bob" });
                expect(
                    (yield* alice.backend.loadSubset(objectSubset("Item"))).rows.map(({ key }) => key)
                ).toEqual(["a"]);
                expect(
                    (yield* bob.backend.loadSubset(objectSubset("Item"))).rows.map(({ key }) => key)
                ).toEqual(["b"]);
                expect(
                    yield* Effect.result(
                        alice.backend.applyAction({
                            id: "denied",
                            name: "edit",
                            parameters: { item: "b", title: "No" },
                        })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotFound", actionOutcome: "not-committed" },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Item", "b"))).toMatchObject({
                    title: "B",
                });
                yield* alice.backend.applyAction({
                    id: "allowed",
                    name: "edit",
                    parameters: { item: "a", title: "Updated" },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Item", "a"))).toMatchObject({
                    title: "Updated",
                });
                expect(yield* Effect.result(local.ontology("unknown"))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotFound" },
                });
            })
        )
    );
});

test("connection cleanup cancels subscriptions without closing the borrowed server", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* owned();
                let watchers = 0;
                const acquired = yield* Deferred.make<void>();
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "proxy",
                    ir,
                    backend: {
                        ...backend,
                        watchSubset: () =>
                            Effect.acquireRelease(
                                Effect.gen(function* () {
                                    watchers++;
                                    yield* Deferred.succeed(acquired, undefined);
                                    return Stream.never;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        watchers--;
                                    })
                            ),
                    },
                    dangerouslyAllowInternalAccess: true,
                });
                const connectionScope = yield* Scope.make();
                const local = yield* Scope.provide(makeOntologyLocalClient(server), connectionScope);
                const connection = yield* Scope.provide(local.ontology(), connectionScope);
                const subscription = yield* Scope.provide(
                    Stream.runDrain(
                        Stream.unwrap(connection.backend.watchSubset!(objectSubset("Item"))!)
                    ).pipe(Effect.forkScoped),
                    connectionScope
                );
                yield* Deferred.await(acquired);
                expect(watchers).toBe(1);
                yield* Scope.close(connectionScope, Exit.void);
                expect(watchers).toBe(0);
                expect(Exit.isFailure(yield* Fiber.await(subscription))).toBe(true);
                const replacement = yield* makeOntologyLocalClient(server);
                const reopened = yield* replacement.ontology();
                expect((yield* reopened.backend.loadSubset(objectSubset("Item"))).rows).toHaveLength(2);
            })
        )
    );
});

test("the local replica protocol accepts speculative actions and streams state", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* owned();
                const parent = yield* makeReplica({
                    namespace: "local-rpc-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    mutators: { edit },
                    live: false,
                });
                yield* parent.demand.acquire(objectSubset("Item"));
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "replica",
                    replica: parent,
                    backend,
                    ir,
                    dangerouslyAllowInternalAccess: true,
                });
                const local = yield* makeOntologyLocalClient(server);
                const connection = yield* local.ontology();
                if (connection.replication.kind !== "speculative")
                    throw new Error("Expected speculative protocol.");
                const source = connection.replication.source;
                const session = yield* source.openClient();
                const view = {
                    generation: 1,
                    selection: { subsets: [{ objectType: "Item" }], actionIds: ["edit-one"] },
                };
                yield* source.accept!({
                    session,
                    sequence: 1,
                    invocation: {
                        id: "edit-one",
                        name: "edit",
                        parameters: { item: "a", title: "Optimistic" },
                    },
                    optimistic: true,
                    view,
                });
                const state = yield* source.read(session, view);
                expect(state.state.pending.map((entry) => entry.invocation.id)).toEqual(["edit-one"]);
                expect(yield* parent.get("Item", "a")).toMatchObject({ title: "Optimistic" });
                const delivery = yield* source.subscribe!(session, view);
                const pull = yield* Stream.toPull(delivery.frames);
                let installed = false;
                while (!installed) {
                    const frames = yield* pull;
                    const end = frames.find((frame) => frame.end);
                    if (end) {
                        yield* delivery.acknowledge(end);
                        installed = true;
                    }
                }
                yield* parent.syncOnce;
                expect(yield* backend.storage.read((tx) => tx.get("Item", "a"))).toMatchObject({
                    title: "Optimistic",
                });
            })
        )
    );
});

test("local attachment operations keep streamed upload and download semantics", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* owned();
                const bytes = new Map<string, Blob>();
                const stage = (value: { id: string }, input: ByteInput) =>
                    Effect.gen(function* () {
                        const blob = yield* collectByteBlob(input).pipe(
                            Effect.mapError(
                                (cause) =>
                                    new BackendError({
                                        operation: "test.stage",
                                        kind: "InvalidResponse",
                                        retryable: false,
                                        message: "Invalid bytes",
                                        cause,
                                    })
                            )
                        );
                        bytes.set(value.id, blob);
                        return value;
                    });
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "proxy",
                    backend: {
                        ...backend,
                        attachments: {
                            stage,
                            read: (value) => Effect.succeed(bytes.get(value.id)!),
                            metadata: (value) =>
                                Effect.succeed({
                                    size: bytes.get(value.id)!.size,
                                    type: bytes.get(value.id)!.type,
                                }),
                        },
                    },
                    ir,
                    dangerouslyAllowInternalAccess: true,
                });
                const local = yield* makeOntologyLocalClient(server);
                const connection = yield* local.ontology();
                const expected = new Uint8Array(150_000).map((_, index) => index % 251);
                const created = yield* connection.operations.attachments.create(
                    new Blob([expected], { type: "application/octet-stream" }),
                    { id: "file" }
                );
                expect(created.attachment.id).toBe("file");
                expect(yield* connection.operations.attachments.metadata(created.attachment)).toMatchObject({
                    size: expected.length,
                });
                const downloaded = yield* connection.operations.attachments.blob(created.attachment);
                expect(new Uint8Array(yield* Effect.promise(() => downloaded.arrayBuffer()))).toEqual(
                    expected
                );
            })
        )
    );
});
