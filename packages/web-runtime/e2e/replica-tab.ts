import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { makeReplica } from "@party-stack/ontology-replica";
import { connectOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { makeReplicatedCollection } from "@party-stack/ontology/tanstack";
import { Runtime, RuntimePartition } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import { increment, ir } from "./replica-fixture.js";

const namespace = new URL(window.location.href).searchParams.get("scope")!;
const workerUrl = new URL("./owner-worker.ts", import.meta.url);
workerUrl.searchParams.set("scope", namespace);
const makeTab = Effect.gen(function* () {
    const runtime = yield* Runtime;
    const worker = yield* Effect.acquireRelease(
        Effect.sync(() => new SharedWorker(workerUrl, { name: namespace, type: "module" })),
        (worker) => Effect.sync(() => worker.port.close())
    );
    const connection = yield* connectOntologyWorker({ connectionTimeoutMs: 15_000 }).pipe(
        Effect.provide(BrowserWorker.layer(() => worker))
    );
    if (connection.replication.kind !== "speculative") throw new Error("Expected a replica host.");
    const source = connection.replication.source;
    const replica = yield* makeReplica({
        namespace: "tab",
        ir,
        tables: runtime.tables,
        source,
        execute: increment,
    });
    const collection = yield* makeReplicatedCollection<{ id: string; count: number }>({
        id: "counter",
        objectType: "Counter",
        replica,
        getKey: (row) => row.id,
    });
    yield* replica.demand({ objectType: "Counter" });
    return { replica, collection, ownerSourceId: source.sourceId };
});
class Tab extends Context.Service<Tab, Effect.Success<typeof makeTab>>()("test/Tab") {}
const app = ManagedRuntime.make(
    Layer.effect(Tab, makeTab).pipe(
        Layer.provide(
            WebRuntime.layer({ storage: "memory" }).pipe(
                Layer.provide(
                    Layer.succeed(RuntimePartition)({ owner: "tab-test", namespace: crypto.randomUUID() })
                )
            )
        )
    )
);
const tab = await app.runPromise(Tab);
Reflect.set(window, "replicaTest", {
    sourceId: () => tab.ownerSourceId,
    rows: async () =>
        (
            await queryOnce((q) =>
                q
                    .from({ counter: tab.collection })
                    .select(({ counter }) => ({ id: counter.id, count: counter.count }))
            )
        ).map(({ id, count }) => ({ id, count })),
    enqueue: (id: string) => app.runPromise(tab.replica.enqueue({ id, name: "increment", parameters: {} })),
    receipt: (id: string) => app.runPromise(tab.replica.receipt(id)),
    cleanup: () => app.dispose(),
});
