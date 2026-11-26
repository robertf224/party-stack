import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Scope, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { replicaStateSource } from "./infrastructure.js";
import { makeReplica as makeFollowingReplica } from "./make.js";
import { editableMetadata, makeReplica as makeChild } from "./testing.js";
import type { DeliveryFrame } from "@party-stack/ontology-backend/delivery";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";

const type = (name: string, extra: OntologyIR["objectTypes"][number]["properties"] = []) => ({
    name,
    displayName: name,
    pluralDisplayName: name,
    primaryKey: "id",
    properties: [{ name: "id", displayName: "Id", type: o.string({}) }, ...extra],
});
const definition = (itemExtra: OntologyIR["objectTypes"][number]["properties"] = []): OntologyIR => ({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [type("Item", itemExtra), type("Other")],
});
const v1 = definition();
const labelled = (ir: OntologyIR) =>
    ir.objectTypes.some((type) => type.properties.some(({ name }) => name === "label"));
// Item gains a property; Other is unchanged.
const v2 = definition([{ name: "label", displayName: "Label", type: o.string({}) }]);

test("after its parent reopens under a new definition, a child receives only the changed types again", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const rows = (ir: OntologyIR, objectType: string) =>
                    ["a", "b"].map((id) => ({
                        key: id,
                        value: { id, ...(objectType === "Item" && labelled(ir) ? { label: id } : {}) },
                    }));
                const metadata = yield* editableMetadata(v1);
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "parent" });
                const parent = yield* makeFollowingReplica({
                    definition: { kind: "dynamic", meta: metadata.backend },
                    backend: (ir) =>
                        Effect.succeed(
                            makeOntologyBackend({
                                ir,
                                name: "upstream",
                                sourceId: "upstream",
                                supportsIdempotency: false,
                                applyAction: () => Effect.die("Unexpected action"),
                                queryFunction: () => Effect.void,
                                loadSubset: (request) =>
                                    Effect.map(compileObjectSubset(ir, request), (subset) => ({
                                        complete: true,
                                        rows: evaluateQuery(rows(ir, subset.objectType), subset.query ?? {}),
                                    })),
                            })
                        ),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));

                // The child talks to whichever engine the parent has open, as a server does.
                const delivered: { objectType: string; kind: string }[] = [];
                const streams = new Set<string>();
                const current = () => replicaStateSource(parent) as unknown as Record<string, unknown>;
                const source = new Proxy({} as OntologySource, {
                    get: (_, key) => {
                        if (key === "subscribe")
                            return (...args: Parameters<NonNullable<OntologySource["subscribe"]>>) =>
                                Effect.map(
                                    (current().subscribe as NonNullable<OntologySource["subscribe"]>)(
                                        ...args
                                    ),
                                    (subscription) => ({
                                        ...subscription,
                                        frames: subscription.frames.pipe(
                                            Stream.tap((frame: DeliveryFrame) =>
                                                Effect.sync(() => {
                                                    streams.add(frame.streamId);
                                                    for (const change of frame.changes) {
                                                        const target =
                                                            change.kind === "put"
                                                                ? change.record
                                                                : change.ref;
                                                        if ("objectType" in target)
                                                            delivered.push({
                                                                objectType: target.objectType,
                                                                kind: change.kind,
                                                            });
                                                    }
                                                })
                                            )
                                        ),
                                    })
                                );
                        const value = current()[key as string];
                        return typeof value === "function" ? value.bind(current()) : value;
                    },
                });

                const childTables = yield* Memory.make();
                const openChild = (ir: OntologyIR) =>
                    Effect.gen(function* () {
                        const scope = yield* Scope.make();
                        const child = yield* Scope.provide(
                            makeChild({
                                namespace: "child",
                                ir,
                                tables: childTables,
                                source,
                                execute: () => Effect.void,
                                onDefinitionChange: "reset",
                            }),
                            scope
                        );
                        for (const objectType of ["Item", "Other"])
                            yield* Scope.provide(child.demand({ objectType }), scope);
                        for (const objectType of ["Item", "Other"]) yield* child.syncSubset({ objectType });
                        return { child, close: Scope.close(scope, Exit.void) };
                    });

                const first = yield* openChild(v1);
                expect((yield* first.child.loadSubset("Other")).length).toBe(2);
                expect(delivered.filter((entry) => entry.objectType === "Other").length).toBe(2);
                yield* first.close;

                yield* metadata.edit(v2);
                yield* parent.definition.changes.pipe(Stream.filter(labelled), Stream.runHead);
                delivered.length = 0;

                const second = yield* openChild(v2);
                expect((yield* second.child.loadSubset("Item")).map((row) => row.value)).toEqual([
                    { id: "a", label: "a" },
                    { id: "b", label: "b" },
                ]);
                expect((yield* second.child.loadSubset("Other")).length).toBe(2);
                // The child resumed its stream, and only Item's rows travelled again.
                expect(streams.size).toBe(1);
                expect(delivered.filter((entry) => entry.objectType === "Other")).toEqual([]);
                // Item's rows went again in the new shape. The parent cleared its own Item rows when it
                // reopened, so the child may first be told they are gone until the parent has them.
                expect(
                    delivered.filter((entry) => entry.objectType === "Item" && entry.kind === "put").length
                ).toBe(2);
                yield* second.close;
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
