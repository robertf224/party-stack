import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { makeReplica } from "@party-stack/ontology-replica";
import { makeOntologyWorkerClient } from "@party-stack/ontology-server/rpc/worker";
import { makeReplicatedCollection } from "@party-stack/ontology/tanstack";
import { RuntimePartition } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import { increment, ir } from "./replica-fixture.js";

const namespace = new URL(window.location.href).searchParams.get("scope")!;
const workerUrl = new URL("./owner-worker.ts", import.meta.url);
workerUrl.searchParams.set("scope", namespace);
const makeTab = Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(
        Effect.sync(() => new SharedWorker(workerUrl, { name: namespace, type: "module" })),
        (worker) => Effect.sync(() => worker.port.close())
    );
    const connection = yield* makeOntologyWorkerClient({ connectionTimeoutMs: 15_000 }).pipe(
        Effect.provide(BrowserWorker.layer(() => worker)),
        Effect.flatMap((client) => client.ontology())
    );
    if (connection.replication.kind !== "speculative") throw new Error("Expected a replica host.");
    const source = connection.replication.source;
    const replica = yield* makeReplica({
        id: "tab",
        ir,
        backend: connection.backend,
        source,
        mutators: { increment },
    });
    const collection = yield* makeReplicatedCollection<{ id: string; count: number }>({
        id: "counter",
        objectType: "Counter",
        replica,
        getKey: (row) => row.id,
    });
    yield* replica.demand.acquire({ from: { source: { objectType: "Counter" }, binding: "row" } });
    return {
        replica,
        collection,
        ownerSourceId: source.sourceId,
        parentMonitor: connection.operations.replicaMonitor,
    };
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
    ownerNetwork: async (online: boolean) => {
        const channel = new BroadcastChannel(`owner-network:${namespace}`);
        const id = crypto.randomUUID();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                timeout = setTimeout(() => reject(new Error("Worker network control timed out")), 5_000);
                channel.onmessage = (event) => {
                    if ((event.data as { id: string }).id === id) resolve();
                };
                channel.postMessage({ id, online });
            });
        } finally {
            clearTimeout(timeout);
            channel.close();
        }
    },
    rows: async () =>
        (
            await queryOnce((q) =>
                q
                    .from({ counter: tab.collection })
                    .select(({ counter }) => ({ id: counter.id, count: counter.count }))
            )
        ).map(({ id, count }) => ({ id, count })),
    enqueue: (id: string) =>
        app.runPromise(tab.replica.outbox.enqueue({ id, name: "increment", parameters: {} })),
    receipt: (id: string) => app.runPromise(tab.replica.outbox.get(id)).then((status) => status.receipt),
    diagnostics: async (id: string) => {
        const action = await app.runPromise(tab.replica.outbox.get(id));
        const status = await app.runPromise(tab.replica.status.get);
        const parent = await new Promise<ReturnType<typeof tab.parentMonitor.getSnapshot>>((resolve) => {
            let stop = () => {};
            const publish = () => {
                const snapshot = tab.parentMonitor.getSnapshot();
                if (snapshot.status || snapshot.error) {
                    stop();
                    resolve(snapshot);
                }
            };
            stop = tab.parentMonitor.subscribe(publish);
            publish();
        });
        return { action, status, parent };
    },
    cleanup: () => app.dispose(),
});
