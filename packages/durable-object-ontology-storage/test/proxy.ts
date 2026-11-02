import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica } from "@party-stack/ontology-replica";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { connectOntologyHttp } from "@party-stack/ontology-server/rpc/http";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeDurableObjectOntologyStorage } from "../src/index.js";
import type { DurableObjectSQLiteStorage } from "../src/index.js";

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
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};

/** Actual DO SQL and the normal HTTP protocol; no speculative server or accepted-write outbox. */
export const runProxyScenario = Effect.fnUntraced(function* (
    storage: DurableObjectSQLiteStorage,
    kind: "proxy" | "cached-proxy"
) {
    const { tables } = yield* makeDurableObjectOntologyStorage({ storage, ontologyId: "proxy-test" });
    let executions = 0,
        loads = 0,
        forwards = 0;
    let loseReply = true;
    const upstream = yield* makeOwnedBackend({
        namespace: "upstream",
        ir,
        tables,
        mutators: {
            increment: (tx) =>
                Effect.gen(function* () {
                    const previous = yield* tx.get("Item", "one");
                    yield* tx.put("Item", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                    executions++;
                }),
        },
    });
    yield* upstream.storage.transaction((tx) => tx.put("Item", { id: "one", count: 0 }));
    const backend = {
        ...upstream,
        // A cache must invalidate after its own writes even without source notifications.
        changes: undefined,
        pollIntervalMs: () => false as const,
        loadSubset: (subset: Parameters<typeof upstream.loadSubset>[0]) =>
            Effect.sync(() => loads++).pipe(Effect.andThen(upstream.loadSubset(subset))),
        applyAction: Effect.fnUntraced(function* (request: Parameters<typeof upstream.applyAction>[0]) {
            forwards++;
            const receipt = yield* upstream.applyAction(request);
            if (loseReply) {
                loseReply = false;
                return yield* new BackendError({
                    operation: "applyAction",
                    kind: "Unavailable",
                    retryable: false,
                    actionOutcome: "unknown",
                    message: "The upstream reply was lost.",
                });
            }
            return receipt;
        }),
    };
    const open = Effect.fnUntraced(function* () {
        const cache =
            kind === "cached-proxy"
                ? yield* makeReplica({
                      ir,
                      tables,
                      namespace: "cache",
                      backend,
                      startSync: false,
                      objectCacheGc: false,
                      demand: { idleRetentionMs: 60_000 },
                  })
                : undefined;
        const { handleRequest } = yield* makeOntologyServer({
            ...(cache ? { kind: "cached-proxy" as const, cache } : { kind: "proxy" as const }),
            backend,
            ir,
            authorize: (_request, headers) =>
                headers.authorization === "Bearer test"
                    ? Effect.void
                    : Effect.fail(
                          new BackendError({
                              operation: "authorize",
                              kind: "Forbidden",
                              retryable: false,
                              message: "Denied",
                          })
                      ),
        });
        const connect = (token: string) =>
            connectOntologyHttp({ url: "https://proxy.test/rpc" }).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
                    const request = new Request(input, init);
                    request.headers.set("authorization", `Bearer ${token}`);
                    return handleRequest(request);
                })
            );
        return { cache, connect };
    });
    const first = yield* Effect.scoped(
        Effect.gen(function* () {
            const { cache, connect } = yield* open();
            const denied = yield* Effect.result(connect("wrong"));
            const client = yield* connect("test");
            const subset = { objectType: "Item" };
            yield* client.backend.loadSubset(subset);
            yield* client.backend.loadSubset(subset);
            const initialLoads = loads;
            const request = { id: "increment-1", name: "increment", parameters: {} };
            const lost = yield* Effect.result(client.backend.applyAction(request));
            const forwardsBeforeRetry = forwards;
            const receipt = yield* client.backend.applyAction(request);
            const repeated = yield* client.backend.applyAction(request);
            const snapshot = yield* client.backend.loadSubset(subset);
            return {
                denied: denied._tag === "Failure" && denied.failure.kind === "Forbidden",
                committed: client.replication.kind === "committed",
                initialLoads,
                lostReplyUnknown: lost._tag === "Failure" && lost.failure.actionOutcome === "unknown",
                forwardsBeforeRetry,
                count: snapshot.rows[0]?.value.count,
                sameReceipt: receipt.operationId === repeated.operationId,
                pending: cache ? (yield* cache.pending).length : 0,
            };
        })
    );
    // Reconstruct the proxy/cache over the same durable tables, with all previous leases closed.
    const reopened = yield* Effect.scoped(
        Effect.gen(function* () {
            const { cache, connect } = yield* open();
            const collected = cache
                ? yield* cache.collectGarbage({ minUnusedAgeMs: 0, maxCandidates: 10 })
                : 0;
            const client = yield* connect("test");
            const snapshot = yield* client.backend.loadSubset({ objectType: "Item" });
            return {
                count: snapshot.rows[0]?.value.count,
                pending: cache ? (yield* cache.pending).length : 0,
                collected,
            };
        })
    );
    return { ...first, executions, reopened };
});
