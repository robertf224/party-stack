import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { makeOntologyBackendInstallation } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { serveInstallationWorker } from "@party-stack/ontology-server/installation/worker";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtimes, Runtime } from "@party-stack/runtime";
import { Effect, Fiber, Layer } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import { increment, ir } from "./replica-fixture.js";
import type { ConnectionController } from "@party-stack/connect";

const identity = (globalThis as unknown as { name: string }).name;
const open = Effect.gen(function* () {
    if (identity.startsWith("fail:"))
        return yield* new BackendError({
            operation: "test.startup",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Deliberate startup failure.",
        });
    const authority = yield* Memory.make();
    const root = yield* Layer.build(Runtimes.layer(WebRuntime.layer()));
    return yield* makeOntologyBackendInstallation({
        installationId: identity,
        connections: Effect.fnUntraced(function* () {
            const runtime = yield* Runtime;
            const table = Table.make<{ userId: string }>({ name: "credentials" });
            const entry = (userId: string) => ({
                connection: { userId, state: { status: "active" as const } },
                session: {
                    disconnect: () => runtime.tables.delete(table, userId).pipe(Effect.orDie),
                },
            });
            return {
                name: "test",
                createAuthenticationClient: (controller: ConnectionController) => ({
                    signIn: (userId: string) =>
                        Effect.runPromise(
                            runtime.tables
                                .put(table, userId, { userId })
                                .pipe(Effect.andThen(controller.connect(entry(userId))))
                        ),
                }),
                restoreConnections: () =>
                    runtime.tables.query(table).pipe(
                        Effect.map((rows) => rows.map(({ value }) => entry(value.userId))),
                        Effect.orDie
                    ),
            };
        }),
        routes: [
            {
                matches: () => true,
                configure: ({ ontologyId }) => ({
                    ir,
                    backend: () => ({
                        name: "test",
                        open: () =>
                            makeOwnedBackend({
                                namespace: ontologyId,
                                ir,
                                tables: authority,
                                mutators: { increment },
                            }),
                    }),
                }),
            },
        ],
    }).pipe(Effect.provideContext(root));
});
Effect.runFork(
    Effect.scoped(
        Effect.gen(function* () {
            const server = yield* serveInstallationWorker({ open, idleTimeToLive: 100 }).pipe(
                Effect.provide(BrowserWorkerRunner.layer)
            );
            yield* Fiber.join(server);
        })
    )
);
