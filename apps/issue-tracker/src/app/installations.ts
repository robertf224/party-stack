import { createBetterAuthConnectionAdapter } from "@party-stack/better-auth";
import { makeFoundryBackendInstallation, createFoundryOntologyRoute } from "@party-stack/foundry-ontology";
import { createFoundryUsersIntegration } from "@party-stack/foundry-ontology/users";
import {
    makeOntologyBackendInstallation,
    type OntologyBackendInstallationService,
} from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { connectOntologyBackendHttp } from "@party-stack/ontology-server/rpc/http";
import { Runtime, RuntimePartition, type Runtimes } from "@party-stack/runtime";
import { make as makeWebRuntime } from "@party-stack/web-runtime";
import { Effect, Layer, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import ontology from "../ontology/ontology";
import { foundryUserToUser } from "../ontology/user";
import { authClient } from "./auth";
import {
    FOUNDRY_URL,
    FOUNDRY_CLIENT_ID,
    FOUNDRY_REDIRECT_URL,
    FOUNDRY_ONTOLOGY_RID,
    FOUNDRY_INSTALLATION_ID,
    TRACKER_CACHE_EPOCH,
    trackerWrites,
} from "./trackerConfig";

// This example deliberately opts into persistent browser credentials.
export const trackerRuntime = Layer.effect(
    Runtime,
    Effect.gen(function* () {
        const { owner, namespace } = yield* RuntimePartition;
        return yield* makeWebRuntime({ persistEncryptionKeys: true }).pipe(
            Effect.provideService(RuntimePartition, {
                owner,
                namespace: owner === "installation" ? namespace : `${TRACKER_CACHE_EPOCH}:${namespace}`,
            })
        );
    })
);

export function makeTrackerInstallation(
    installationId: string
): Effect.Effect<OntologyBackendInstallationService, BackendError, Runtimes | Scope.Scope> {
    if (installationId === "issue-tracker-sqlite") return makeSqliteInstallation();
    if (installationId === FOUNDRY_INSTALLATION_ID) return makeFoundryInstallation();
    return Effect.fail(
        new BackendError({
            operation: "installation.open",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Unknown ontology installation.",
        })
    );
}

function makeFoundryInstallation() {
    const foundryUsers = createFoundryUsersIntegration({
        objectType: "User",
        lens: foundryUserToUser,
    });

    return makeFoundryBackendInstallation({
        baseUrl: FOUNDRY_URL,
        connections: {
            oauth: {
                clientId: FOUNDRY_CLIENT_ID,
                redirectUrl: FOUNDRY_REDIRECT_URL,
                scopes: [
                    "api:admin-read",
                    "api:use-ontologies-read",
                    "api:use-ontologies-write",
                    "api:use-mediasets-read",
                    "api:use-mediasets-write",
                    "offline_access",
                ],
            },
        },
        routes: [
            createFoundryOntologyRoute({
                ontologyId: FOUNDRY_ONTOLOGY_RID,
                ir: ontology,
                users: foundryUsers,
                writes: trackerWrites,
            }),
        ],
    });
}

function makeSqliteInstallation() {
    return makeOntologyBackendInstallation<typeof authClient>({
        installationId: "issue-tracker-sqlite",
        connections: createBetterAuthConnectionAdapter({
            client: authClient,
        }),
        routes: [
            {
                matches: (ontologyId) => ontologyId === "issue-tracker",
                configure: ({ egress }) => ({
                    ir: ontology,
                    backend: () => ({
                        name: "sqlite",
                        open: () =>
                            connectOntologyBackendHttp({
                                url: new URL("/api/remote-ontology/rpc", globalThis.location.origin).href,
                            }).pipe(
                                Effect.provide(FetchHttpClient.layer),
                                Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                                    egress.fetch(new Request(input, init))
                                )
                            ),
                    }),
                    writes: trackerWrites,
                }),
            },
        ],
    });
}
