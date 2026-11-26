import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { createOntologyClient } from "./client.js";
import { createLiveOntology } from "./live/LiveOntology.js";
import { localClient } from "./local.js";
import type { LiveOntology } from "./live/LiveOntology.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
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

const labelled = (ir: OntologyIR) =>
    ir.objectTypes[0]!.properties.some((property) => property.name === "label");

/** Metadata whose definition can be edited. Watches report each edit. */
const editableMetadata = (initial: OntologyIR) =>
    Effect.gen(function* () {
        let current = initial;
        const edits = yield* PubSub.unbounded<void>();
        const backend: OntologyBackendService = {
            ...makeMetadataBackend(initial),
            loadSubset: (subset) => Effect.suspend(() => makeMetadataBackend(current).loadSubset(subset)),
            query: (document, settings) =>
                Effect.suspend(() => makeMetadataBackend(current).query(document, settings)),
            watchSubset: () =>
                Effect.map(PubSub.subscribe(edits), (subscription) =>
                    Stream.fromSubscription(subscription).pipe(Stream.as("reset" as const))
                ),
        };
        const edit = (next: OntologyIR) =>
            Effect.suspend(() => {
                current = next;
                return PubSub.publish(edits, undefined);
            });
        return { backend, edit };
    });

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

test("an idle view over a replica that follows its definition becomes stale, and a reopened view uses the new one", async () => {
    const owner = Effect.runSync(Scope.make());
    try {
        const { server, metadata } = await Effect.runPromise(
            Scope.provide(
                Effect.gen(function* () {
                    const metadata = yield* editableMetadata(v1);
                    const platform = yield* Layer.build(Runtimes.layer(MemoryRuntime.layer));
                    const server = yield* makeOntologyServer({
                        enableRealtime: true,
                        replicas: {},
                        routes: {
                            items: {
                                kind: "replica",
                                definition: { kind: "dynamic", meta: metadata.backend },
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
                                                                value: labelled(ir)
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
                    return { server, metadata };
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

                // No live query is mounted and no request fails: the view learns of the change by
                // watching the route's metadata.
                await Effect.runPromise(metadata.edit(v2));
                await stale(live);
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
