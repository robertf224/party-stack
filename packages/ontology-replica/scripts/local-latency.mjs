// Generic local prediction benchmark. No network, browser, framework or app data.
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { make as memoryTables } from "@party-stack/ontology-storage/memory/tables";
import { createTraceCapture } from "@party-stack/runtime/tracing";
import { Effect, Stream, Tracer } from "effect";
import { makeReplicaKernel } from "../lib/engine.js";

const ir = {
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
                { name: "text", displayName: "Text", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "put",
            displayName: "Put",
            logic: [],
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "text", displayName: "Text", type: o.string({}) },
            ],
        },
    ],
};
const execute = (tx, action) => tx.put("Item", action.parameters);
const percentile = (values, fraction) =>
    [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
const results = [];
for (const history of [false, true])
    for (const size of [1, 1000]) {
        const capture = createTraceCapture(500, undefined, history);
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* makeOwnedBackend({
                        namespace: "authority",
                        ir,
                        tables: yield* memoryTables(),
                        mutators: { put: execute },
                    });
                    yield* owned.storage.transaction((tx) =>
                        Effect.forEach(
                            Array.from({ length: size }, (_, i) => i),
                            (i) => tx.put("Item", { id: `base-${i}`, text: "x".repeat(100) }),
                            { discard: true }
                        )
                    );
                    let measuring = false;
                    const transactions = [];
                    const tables = yield* memoryTables();
                    const measured = {
                        ...tables,
                        transaction: (body) =>
                            Effect.suspend(() => {
                                const start = performance.now();
                                let entered;
                                return tables
                                    .transaction((tx) => {
                                        entered = performance.now();
                                        return body(tx);
                                    })
                                    .pipe(
                                        Effect.onExit(() =>
                                            Effect.sync(() => {
                                                if (measuring)
                                                    transactions.push({
                                                        wait: entered - start,
                                                        body: performance.now() - entered,
                                                    });
                                            })
                                        )
                                    );
                            }),
                    };
                    const replica = yield* makeReplicaKernel({
                        namespace: "local",
                        ir,
                        tables: measured,
                        backend: owned,
                        execute,
                        startSync: false,
                        objectCacheGc: false,
                    });
                    yield* replica.demand({ objectType: "Item" });
                    yield* replica.syncOnce;
                    const durations = [];
                    measuring = true;
                    for (let i = 0; i < 100; i++) {
                        const start = performance.now();
                        yield* replica.enqueue({
                            id: `action-${i}`,
                            name: "put",
                            parameters: { id: `created-${i}`, text: "" },
                        });
                        durations.push(performance.now() - start);
                    }
                    measuring = false;
                    results.push({
                        history,
                        size,
                        enqueue: {
                            p50: percentile(durations, 0.5),
                            p95: percentile(durations, 0.95),
                            max: Math.max(...durations),
                        },
                        transactionWait: Math.max(...transactions.map((t) => t.wait)),
                        transactionBody: percentile(
                            transactions.map((t) => t.body),
                            0.5
                        ),
                    });
                })
            ).pipe(Effect.provideService(Tracer.Tracer, capture.tracer))
        );
    }
console.log(JSON.stringify(results, null, 2));
