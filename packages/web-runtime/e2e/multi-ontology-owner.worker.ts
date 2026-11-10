import { runMain } from "@effect/platform-browser/BrowserRuntime";
import { layer as workerRunner } from "@effect/platform-browser/BrowserWorkerRunner";
import {
    makeConnectManager,
    connectPublicOntologyIR,
    ConnectError,
    type ConnectManagerService,
} from "@party-stack/connect";
import { connectOntology } from "@party-stack/connect/spec";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeOntologyServer, type OntologyServer } from "@party-stack/ontology-server";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { o } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { TraceRecording } from "@party-stack/runtime/tracing";
import { Effect, Fiber, Schema } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";
import { increment, ir as baseIr } from "./replica-fixture.js";

const ir = {
    ...baseIr,
    context: {
        type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }),
        partition: [["user"]],
    },
};
const identity = (globalThis as unknown as { name: string }).name;
const Selection = Schema.Struct({
    connectionId: Schema.NonEmptyString,
    ontologyId: Schema.Literals(["first-ontology", "second-ontology"]),
});
const forget = {
    name: "forgetAccount",
    displayName: "Forget local account",
    logic: [],
    parameters: [
        {
            name: "connectionId",
            displayName: "Connection",
            type: o.objectReference({ objectType: "ExternalSessionConnection" }),
        },
    ],
};
const privateIR = { ...connectOntology, actionTypes: [...connectOntology.actionTypes, forget] };
const publicIR = {
    ...privateIR,
    policy: {
        ...connectPublicOntologyIR.policy!,
        actions: [
            ...(connectPublicOntologyIR.policy!.actions ?? []),
            {
                actionType: "forgetAccount",
                check: q.literal(true),
                read: connectPublicOntologyIR.policy!.objects,
            },
        ],
    },
};

const server = Effect.gen(function* () {
    const runtime = yield* (yield* Runtimes).acquire({ owner: "connections", namespace: identity });
    const authority = yield* Memory.make();
    let server: OntologyServer;
    const connect: ConnectManagerService = yield* makeConnectManager({
        ir: privateIR,
        services: [
            {
                connector: {
                    service: "fixture",
                    externalSession: ({ sessionId }) =>
                        sessionId === "alice"
                            ? Effect.succeed({ userId: "alice" })
                            : Effect.fail(
                                  new ConnectError({
                                      kind: "NeedsAuthentication",
                                      retryable: false,
                                      message: "Unknown test session",
                                  })
                              ),
                    acquire: ({ handlers }) => Effect.succeed(handlers),
                },
                instances: [{ id: "fixture", title: "Fixture", instanceUrl: "https://fixture.example" }],
            },
        ],
        actionHandlers: {
            forgetAccount: Effect.fnUntraced(function* (request) {
                const id = request.parameters.connectionId as string;
                for (const stored of yield* server.partitions) {
                    const selection = yield* Schema.decodeUnknownEffect(Selection)({
                        connectionId: decodeURIComponent(stored.ontology.split("/")[1]!),
                        ontologyId: stored.ontology.split("/")[2],
                    }).pipe(
                        Effect.mapError(
                            () =>
                                new BackendError({
                                    operation: "forget",
                                    kind: "InvalidConfiguration",
                                    retryable: false,
                                    message: "Invalid stored target",
                                })
                        )
                    );
                    if (selection.connectionId === id) yield* server.forget(stored.ontology);
                }
                yield* connect.store.delete("ExternalSessionConnection", id);
            }),
        },
    }).pipe(Effect.provideService(Runtime, runtime));
    server = yield* makeOntologyServer({
        enableRealtime: true,
        replicas: { scope: identity },
        idleRetentionMs: identity.startsWith("fail:") ? -1 : 100,
        routes: {
            connect: {
                kind: "proxy",
                backend: connect.backend,
                ir: publicIR,
                context: {},
            },
            "counters/:connectionId/:ontologyId": Effect.fnUntraced(function* (
                params: Readonly<Record<string, string>>
            ) {
                const selection = yield* Schema.decodeUnknownEffect(Selection)(params).pipe(
                    Effect.mapError(
                        () =>
                            new BackendError({
                                operation: "resolve",
                                kind: "NotFound",
                                retryable: false,
                                message: "Unknown ontology",
                            })
                    )
                );
                const session = yield* connect.connections.acquire({
                    objectType: "ExternalSessionConnection",
                    id: selection.connectionId,
                });
                return {
                    kind: "replica" as const,
                    dangerouslyAllowInternalAccess: true as const,
                    ir,
                    namespace: selection.ontologyId,
                    context: { user: session.userId },
                    authentication: session.authentication,
                    backend: yield* makeOwnedBackend({
                        namespace: selection.ontologyId,
                        ir,
                        tables: authority,
                        mutators: { increment },
                    }),
                };
            }),
        },
    });
    return server;
});

serveOntologyWorker(server).pipe(
    Effect.flatMap(Fiber.join),
    Effect.scoped,
    Effect.provide(WebRuntime.webRuntime({ persistEncryptionKeys: true })),
    Effect.provide(workerRunner),
    Effect.provideService(TraceRecording, "live"),
    runMain
);
