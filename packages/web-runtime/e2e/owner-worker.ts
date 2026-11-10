import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica } from "@party-stack/ontology-replica";
import { replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Runtime, RuntimePartition, makeNetworkConnectivity } from "@party-stack/runtime";
import { Effect, Fiber, Layer, Schema } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import { increment, ir } from "./replica-fixture.js";

const namespace = new URL(globalThis.location.href).searchParams.get("scope")!;
Effect.runFork(
    Effect.scoped(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            // Fault injection: CDP's page offline emulation does not reliably
            // change navigator.onLine in an already-running SharedWorker.
            const connectivity = yield* makeNetworkConnectivity(true);
            const control = yield* Effect.acquireRelease(
                Effect.sync(() => new BroadcastChannel(`owner-network:${namespace}`)),
                (channel) => Effect.sync(() => channel.close())
            );
            const command = Schema.Struct({ id: Schema.String, online: Schema.Boolean });
            control.onmessage = (event) => {
                const message = Schema.decodeUnknownSync(command)(event.data);
                Effect.runSync(connectivity.set(message.online));
                control.postMessage({ id: message.id });
            };
            const backend = yield* makeOwnedBackend({
                namespace: "authority",
                ir,
                tables: runtime.tables,
                mutators: { increment },
            });
            const owner = yield* makeReplica({
                id: "owner",
                ir,
                backend,
                mutators: { increment },
                demand: { refresh: { pollIntervalMs: 600_000 } },
            }).pipe(Effect.provideService(Runtime, { ...runtime, connectivity }));
            const server = yield* serveOntologyWorker({
                enableRealtime: true,
                source: replicaStateSource(owner),
                replica: owner,
                authorize: () => Effect.void,
            }).pipe(Effect.provide(BrowserWorkerRunner.layer));
            yield* Fiber.join(server);
        })
    ).pipe(
        Effect.provide(
            WebRuntime.layer().pipe(
                Layer.provide(Layer.succeed(RuntimePartition)({ owner: "worker-test", namespace }))
            )
        )
    )
);
