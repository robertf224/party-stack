import { runMain } from "@effect/platform-browser/BrowserRuntime";
import { layer as workerRunner } from "@effect/platform-browser/BrowserWorkerRunner";
import { makeConnectManager, connectDeviceRoute } from "@party-stack/connect";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { o } from "@party-stack/ontology-spec";
import metaOntology from "@party-stack/ontology-spec/meta";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { makeSalesforceServiceConnector } from "@party-stack/salesforce-ontology";
import {
    makeSalesforceBackend,
    makeSalesforceMetadataBackend,
} from "@party-stack/salesforce-ontology/connect";
import { webRuntime } from "@party-stack/web-runtime";
import { Effect, Fiber, Schema } from "effect";
import ontology from "../ontology/ontology";
import { SALESFORCE_TASK_MANAGER_ONTOLOGY_ID } from "../settings";
import { instanceUrl, loginUrl, clientId, redirectUrl, apiVersion } from "./salesforce-config";

const metadata = {
    ...metaOntology,
    context: {
        type: o.struct({ fields: [{ name: "userId", displayName: "User", type: o.string({}) }] }),
        partition: [["userId"]],
    },
};
const server = Effect.gen(function* () {
    const runtime = yield* (yield* Runtimes).acquire({
        owner: "connect",
        namespace: `salesforce:${instanceUrl}`,
    });
    const manager = yield* makeConnectManager({
        services: [
            {
                connector: makeSalesforceServiceConnector({ loginUrl }),
                instances: [
                    {
                        id: "salesforce",
                        title: "Salesforce",
                        instanceUrl,
                        OAuthApplications: [
                            {
                                id: clientId,
                                title: "Salesforce task manager",
                                clientId,
                                redirectUrl,
                                flow: "authorization-code",
                            },
                        ],
                    },
                ],
            },
        ],
    }).pipe(Effect.provideService(Runtime, runtime));
    const route = (meta: boolean) =>
        Effect.fnUntraced(function* ({ type, connection }: Readonly<Record<string, string>>) {
            const ref = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                    objectType: Schema.Literals(["OAuthConnection", "ApiKeyConnection"]),
                    id: Schema.NonEmptyString,
                })
            )({ objectType: type, id: connection }).pipe(
                Effect.mapError(
                    () =>
                        new BackendError({
                            operation: "route",
                            kind: "NotFound",
                            retryable: false,
                            message: "Unknown Salesforce connection.",
                        })
                )
            );
            const access = yield* manager.connections.acquire(ref);
            const context = meta ? { userId: access.userId } : { user: access.userId };
            const backend = meta
                ? yield* makeSalesforceMetadataBackend({ instanceUrl, apiVersion, egress: access.egress })
                : yield* makeSalesforceBackend({
                      instanceUrl,
                      apiVersion,
                      egress: access.egress,
                      ir: ontology,
                      context,
                  });
            return {
                kind: "replica" as const,
                dangerouslyAllowInternalAccess: true as const,
                ir: meta ? metadata : ontology,
                namespace: `${SALESFORCE_TASK_MANAGER_ONTOLOGY_ID}:${meta ? "metadata" : "data"}`,
                context,
                backend,
                authentication: access.authentication,
            };
        });
    return yield* makeOntologyServer({
        enableRealtime: true,
        routes: {
            connect: connectDeviceRoute(manager),
            "data/:type/:connection": route(false),
            "metadata/:type/:connection": route(true),
        },
    });
});
serveOntologyWorker(server).pipe(
    Effect.flatMap(Fiber.join),
    Effect.scoped,
    Effect.provide(webRuntime({ persistEncryptionKeys: true })),
    Effect.provide(workerRunner),
    runMain
);
