import { makeBetterAuthServiceConnector } from "@party-stack/better-auth";
import { makeConnectManager, connectDeviceRoute, toWebEgress } from "@party-stack/connect";
import { makeFoundryServiceConnector } from "@party-stack/foundry-ontology";
import { makeFoundryBackend } from "@party-stack/foundry-ontology";
import { createFoundryUsersIntegration } from "@party-stack/foundry-ontology/users";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { makeOntologyHttpBackend } from "@party-stack/ontology-server/rpc/http";
import { Runtime, RuntimePartition, Runtimes } from "@party-stack/runtime";
import { make as makeWebRuntime } from "@party-stack/web-runtime";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import ontology from "../ontology/ontology";
import { foundryUserToUser } from "../ontology/user";
import { authClient } from "./auth";
import { migrateTrackerConnections } from "./migrateConnect";
import {
    FOUNDRY_URL,
    FOUNDRY_CLIENT_ID,
    FOUNDRY_REDIRECT_URL,
    FOUNDRY_ONTOLOGY_RID,
    FOUNDRY_INSTALLATION_ID,
    TRACKER_CACHE_EPOCH,
    trackerWrites,
} from "./trackerConfig";

export const trackerRuntime = Layer.effect(
    Runtime,
    Effect.gen(function* () {
        const { owner, namespace } = yield* RuntimePartition;
        return yield* makeWebRuntime({ persistEncryptionKeys: true }).pipe(
            Effect.provideService(RuntimePartition, {
                owner,
                namespace:
                    owner === "installation" || owner === "replica-registry"
                        ? namespace
                        : `${TRACKER_CACHE_EPOCH}:${namespace}`,
            })
        );
    })
);
const Selection = Schema.Struct({
    objectType: Schema.Literals(["OAuthConnection", "ApiKeyConnection", "ExternalSessionConnection"]),
    id: Schema.NonEmptyString,
});
const unknown = () =>
    new BackendError({
        operation: "ontology.resolve",
        kind: "NotFound",
        retryable: false,
        message: "Unknown ontology.",
    });

/** One worker serves Connect and both issue backends. Credentials stay beside the adapters. */
export const makeTrackerOntologyServer = Effect.fn("Tracker.server")(function* () {
    const runtimes = yield* Runtimes;
    const runtime = yield* runtimes.acquire({ owner: "installation", namespace: "issue-tracker-services" });
    const authority = yield* makeConnectManager({
        namespace: "issue-tracker-connect",
        services: [
            {
                connector: makeFoundryServiceConnector(),
                instances: [
                    {
                        id: "foundry",
                        title: "Foundry",
                        instanceUrl: FOUNDRY_URL,
                        OAuthApplications: [
                            {
                                id: FOUNDRY_CLIENT_ID,
                                title: "Issue tracker",
                                flow: "authorization-code",
                                clientId: FOUNDRY_CLIENT_ID,
                                scopes: [
                                    "api:admin-read",
                                    "api:use-ontologies-read",
                                    "api:use-ontologies-write",
                                    "api:use-mediasets-read",
                                    "api:use-mediasets-write",
                                    "offline_access",
                                ],
                                redirectUrl: FOUNDRY_REDIRECT_URL,
                            },
                        ],
                    },
                ],
            },
            {
                connector: makeBetterAuthServiceConnector({ client: authClient }),
                instances: [{ id: "sqlite", title: "SQLite", instanceUrl: globalThis.location.origin }],
            },
        ],
    }).pipe(Effect.provideService(Runtime, runtime));
    yield* migrateTrackerConnections({
        runtimes,
        store: authority.store,
        values: authority.values,
        tables: runtime.tables,
    });
    const connections = authority.connections;
    const users = createFoundryUsersIntegration({ objectType: "User", lens: foundryUserToUser });
    return yield* makeOntologyServer({
        enableRealtime: true,
        routes: {
            connect: {
                ...connectDeviceRoute(authority),
            },
            "issues/:connectionType/:connectionId": Effect.fnUntraced(function* (
                params: Readonly<Record<string, string>>
            ) {
                const selection = yield* Schema.decodeUnknownEffect(Selection)({
                    objectType: params.connectionType,
                    id: params.connectionId,
                }).pipe(Effect.mapError(unknown));
                const access = yield* connections.acquire(selection);
                const userId = access.userId;
                const context = { userId };
                const foundry = access.serviceInstance.service === "foundry";
                const web = yield* toWebEgress(access.egress);
                const backend = foundry
                    ? yield* makeFoundryBackend({
                          baseUrl: access.serviceInstance.instanceUrl,
                          ontologyId: FOUNDRY_ONTOLOGY_RID,
                          egress: access.egress,
                          ir: ontology,
                          context,
                          users,
                      })
                    : yield* makeOntologyHttpBackend({
                          url: new URL("/api/remote-ontology/rpc", access.serviceInstance.instanceUrl).href,
                      }).pipe(
                          Effect.provide(FetchHttpClient.layer),
                          Effect.provideService(FetchHttpClient.Fetch, web.fetch)
                      );
                return {
                    kind: "replica" as const,
                    dangerouslyAllowInternalAccess: true as const,
                    ir: ontology,
                    context,
                    backend,
                    // Preserve the existing persistent cache addresses during this API migration.
                    namespace: foundry
                        ? `${encodeURIComponent(FOUNDRY_INSTALLATION_ID)}:${encodeURIComponent(FOUNDRY_ONTOLOGY_RID)}`
                        : "issue-tracker-sqlite:issue-tracker",
                    authentication: access.authentication,
                    outbox: trackerWrites.outbox,
                    demand: { idleRetentionMs: 5_000 },
                };
            }),
        },
    });
});
