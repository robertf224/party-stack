import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica, replicaStateSource } from "@party-stack/ontology-replica";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Runtime } from "@party-stack/runtime";
import { Effect, Fiber } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import { increment, ir } from "./replica-fixture.js";

const namespace = new URL(globalThis.location.href).searchParams.get("scope")!;
Effect.runFork(
    Effect.scoped(
        Effect.gen(function* () {
            const runtime = yield* Runtime;
            const backend = yield* makeOwnedBackend({
                namespace: "authority",
                ir,
                tables: runtime.tables,
                mutators: { increment },
            });
            const owner = yield* makeReplica({
                namespace: "owner",
                ir,
                tables: runtime.tables,
                backend,
                execute: increment,
            });
            const server = yield* serveOntologyWorker({
                source: replicaStateSource(owner),
                authorize: () => Effect.void,
            }).pipe(Effect.provide(BrowserWorkerRunner.layer));
            yield* Fiber.join(server);
        })
    ).pipe(Effect.provide(WebRuntime.layer({ owner: "worker-test", namespace })))
);
