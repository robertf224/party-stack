import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { Effect } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import { projectOntologyBackend } from "./authorization.js";
import { OntologyRpcs, ontologyRpcHandlers } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    context: { type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }) },
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: ["id", "owner", "title", "secret"].map((name) => ({
                name,
                displayName: name,
                type: o.string({}),
            })),
        },
    ],
    policy: {
        objects: {
            select: [
                q.sub("items", {
                    from: { source: { objectType: "Item" }, binding: "i" },
                    where: q.eq(q.field("i", "owner"), q.context("user")),
                    select: ["id", "title"].map((name) => q.selectField(name, q.field("i", name))),
                }),
            ],
        },
    },
};
const backend: OntologyBackendService = makeOntologyBackend({
    ir,
    name: "test",
    sourceId: "test",
    supportsIdempotency: false,
    applyAction: () => Effect.die("Unexpected action"),
    queryFunction: () => Effect.void,
    loadSubset: () =>
        Effect.succeed({
            complete: true,
            fulfilledSubset: objectSubset("Item"),
            rows: [
                { key: "a", value: { id: "a", owner: "alice", title: "A", secret: "private-a" } },
                { key: "b", value: { id: "b", owner: "bob", title: "B", secret: "private-b" } },
                { key: "c", value: { id: "c", owner: "alice", title: "C", secret: "private-c" } },
            ],
        }),
});

test("finite query reads apply residual filtering/order/window to broader provider data", async () => {
    const result = await Effect.runPromise(
        backend.query({
            select: [
                q.sub("items", {
                    from: { source: { objectType: "Item" }, binding: "item" },
                    where: q.eq(q.field("item", "owner"), q.literal("alice")),
                    orderBy: [{ expression: q.field("item", "title"), direction: "desc" }],
                    page: { offset: 1, limit: 1 },
                    select: [q.selectField("id", q.field("item", "id"))],
                }),
            ],
        })
    );
    expect(result.items).toEqual([{ id: "a" }]);
});

test("authorization projects broader provider data before returning exact downstream coverage", async () => {
    const projected = await Effect.runPromise(
        projectOntologyBackend({ backend, ir, context: { user: "alice" } })
    );
    const snapshot = await Effect.runPromise(projected.backend.loadSubset(objectSubset("Item")));
    expect(snapshot.fulfilledSubset).toBeUndefined();
    expect(snapshot.rows).toEqual([
        { key: "a", value: { id: "a", title: "A" } },
        { key: "c", value: { id: "c", title: "C" } },
    ]);
});

test("RPC retains explicit fulfilled subsets for the receiving replica's cache policy", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            enableRealtime: true,
                            backend,
                            ir,
                            authorize: () => Effect.void,
                        })
                    )
                );
                const snapshot = yield* client.LoadSubset(objectSubset("Item", { limit: 1 }));
                expect(snapshot.fulfilledSubset).toEqual(objectSubset("Item"));
                expect(snapshot.rows).toHaveLength(3);
            })
        )
    );
});
