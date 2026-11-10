import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { field, selectField, sub } from "@party-stack/ontology-spec/query";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { makeOntologyServer } from "./routing.js";

const ir = {
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
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
const query = {
    select: [
        sub("issues", {
            from: { source: { objectType: "Issue" }, binding: "issue" },
            select: [selectField("id", field("issue", "id"))],
        }),
    ],
};
const backend = Effect.fnUntraced(function* (namespace: string) {
    const service = yield* makeOwnedBackend({
        namespace,
        ir,
        tables: yield* Memory.make(),
        mutators: {},
    });
    yield* service.storage.transaction((tx) => tx.put("Issue", { id: "one" }));
    return service;
});

test("native checkpoints share the managed route owner and return its installed pin status", async () => {
    let opened = 0;
    let active = 0;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const upstream = yield* backend("checkpoint-upstream");
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    replicas: {},
                    routes: {
                        "workspaces/:workspaceId/issues": () =>
                            Effect.gen(function* () {
                                yield* Effect.acquireRelease(
                                    Effect.sync(() => {
                                        opened++;
                                        active++;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            active--;
                                        })
                                );
                                return {
                                    kind: "replica" as const,
                                    backend: upstream,
                                    ir,
                                    live: false,
                                    dangerouslyAllowInternalAccess: true as const,
                                };
                            }),
                    },
                });
                const target = "workspaces/first/issues";
                expect(yield* server.syncOnce(target)).toEqual({ pin: undefined });
                expect(opened).toBe(1);
                expect(active).toBe(1);
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const bound = yield* server.bind(target);
                        yield* bound.options.replica!.demand.setPin(query);
                    })
                );
                expect(yield* server.syncOnce(target)).toMatchObject({
                    pin: { query, ready: true, attachments: "none", previousGraphRetained: false },
                });
                expect(opened).toBe(1);
                expect(active).toBe(1);
                expect(yield* server.partitions).toMatchObject([{ ontology: target }]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
    expect(active).toBe(0);
});

test("native checkpoints reject routes without a replica", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    routes: {
                        issues: {
                            kind: "owned",
                            backend: yield* backend("checkpoint-owned"),
                            dangerouslyAllowInternalAccess: true,
                        },
                    },
                });
                expect(yield* Effect.result(server.syncOnce("issues"))).toMatchObject({
                    _tag: "Failure",
                    failure: { operation: "server.syncOnce", kind: "InvalidRequest", retryable: false },
                });
            })
        )
    );
});
