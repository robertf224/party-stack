import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Effect, Exit, Layer, Scope, SubscriptionRef } from "effect";
import { expect, test } from "vite-plus/test";
import { createOntologyClient } from "./client.js";
import { createLiveOntology } from "./live/LiveOntology.js";
import { localClient } from "./local.js";
import type { LiveOntology } from "./live/LiveOntology.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const item = (extra: OntologyIR["objectTypes"][number]["properties"] = []) => ({
    name: "Item",
    displayName: "Item",
    pluralDisplayName: "Items",
    primaryKey: "id",
    properties: [{ name: "id", displayName: "ID", type: o.string({}) }, ...extra],
});
const v1: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [item()],
};
const v2: OntologyIR = {
    ...v1,
    objectTypes: [item([{ name: "label", displayName: "Label", type: o.string({}) }])],
};

const stale = (live: LiveOntology) =>
    new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The view never became stale.")), 10_000);
        const check = () => {
            if (live.definition.get().status !== "stale") return;
            clearTimeout(timeout);
            unsubscribe();
            resolve();
        };
        const unsubscribe = live.definition.subscribe(check);
        check();
    });

test("a view over a replica that follows its definition becomes stale, and a reopened view uses the new one", async () => {
    const owner = Effect.runSync(Scope.make());
    try {
        const { server, source } = await Effect.runPromise(
            Scope.provide(
                Effect.gen(function* () {
                    const source = yield* SubscriptionRef.make(v1);
                    const platform = yield* Layer.build(Runtimes.layer(MemoryRuntime.layer));
                    const server = yield* makeOntologyServer({
                        enableRealtime: true,
                        replicas: {},
                        routes: {
                            items: {
                                kind: "replica",
                                definition: { kind: "dynamic", changes: SubscriptionRef.changes(source) },
                                onDefinitionChange: "reset",
                                backend: (ir) =>
                                    Effect.succeed(
                                        makeOntologyBackend({
                                            ir,
                                            name: "items",
                                            sourceId: "items",
                                            supportsIdempotency: true,
                                            queryFunction: () => Effect.void,
                                            loadSubset: (request) =>
                                                Effect.map(compileObjectSubset(ir, request), (subset) => ({
                                                    complete: true,
                                                    rows: evaluateQuery(
                                                        [
                                                            {
                                                                key: "a",
                                                                value:
                                                                    ir === v2
                                                                        ? { id: "a", label: "x" }
                                                                        : { id: "a" },
                                                            },
                                                        ],
                                                        subset.query ?? {}
                                                    ),
                                                })),
                                            applyAction: (request) =>
                                                Effect.succeed({
                                                    operationId: request.id,
                                                    outcome: "committed" as const,
                                                }),
                                        })
                                    ),
                                dangerouslyAllowInternalAccess: true,
                            },
                        },
                    }).pipe(Effect.provideContext(platform));
                    return { server, source };
                }),
                owner
            )
        );
        const client = await createOntologyClient(localClient(server, { ontology: "items" }));
        try {
            const live = await createLiveOntology({ client });
            try {
                expect(await queryOnce((q) => q.from({ item: live.objects.Item! }))).toMatchObject([
                    { id: "a" },
                ]);
                expect(live.definition.get()).toEqual({ status: "current" });

                // A mounted live query keeps the view's delivery stream open; the parent resends
                // the changed type under its new definition, which the view detects.
                const watching = live.objects.Item!.subscribeChanges(() => {}, { includeInitialState: true });
                try {
                    await Effect.runPromise(SubscriptionRef.set(source, v2));
                    await stale(live);
                } finally {
                    watching.unsubscribe();
                }
                expect(live.definition.get()).toMatchObject({
                    status: "stale",
                    error: { kind: "SchemaMismatch" },
                });
            } finally {
                await live.cleanup();
            }
            const reopened = await createLiveOntology({ client });
            try {
                expect(reopened.ir.objectTypes[0]!.properties.map((property) => property.name)).toEqual([
                    "id",
                    "label",
                ]);
                expect(reopened.definition.get()).toEqual({ status: "current" });
                expect(await queryOnce((q) => q.from({ item: reopened.objects.Item! }))).toMatchObject([
                    { id: "a", label: "x" },
                ]);
            } finally {
                await reopened.cleanup();
            }
        } finally {
            await client.cleanup();
        }
    } finally {
        await Effect.runPromise(Scope.close(owner, Exit.void));
    }
}, 20_000);
