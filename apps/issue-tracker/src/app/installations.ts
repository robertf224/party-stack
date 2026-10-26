import { createBetterAuthConnectionAdapter } from "@party-stack/better-auth";
import { createFoundryBackendInstallation, createFoundryOntologyRoute } from "@party-stack/foundry-ontology";
import { createFoundryUsersIntegration } from "@party-stack/foundry-ontology/users";
import {
    createOntologyBackendInstallation,
    type CreateOntologyBackendInstallationOptions,
    type OntologyBackendInstallation,
} from "@party-stack/ontology";
import { connectOntologyBackendHttp } from "@party-stack/ontology-server/rpc/http";
import { createWebRuntime } from "@party-stack/web-runtime";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import ontology from "../ontology/ontology";
import { foundryUserToUser } from "../ontology/user";
import { authClient } from "./auth";
import { migrateLinkMetadata } from "./migrateLinkMetadata";

const writes = {
    defaultMode: "outbox" as const,
    defaultVisibility: "optimistic" as const,
};

function requiredEnv(name: string, value: string | undefined): string {
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

const FOUNDRY_URL = requiredEnv("VITE_FOUNDRY_URL", import.meta.env.VITE_FOUNDRY_URL);
export const FOUNDRY_ONTOLOGY_RID = requiredEnv(
    "VITE_FOUNDRY_ONTOLOGY_RID",
    import.meta.env.VITE_FOUNDRY_ONTOLOGY_RID
);
const FOUNDRY_CLIENT_ID = requiredEnv("VITE_FOUNDRY_CLIENT_ID", import.meta.env.VITE_FOUNDRY_CLIENT_ID);
const FOUNDRY_REDIRECT_URL =
    import.meta.env.VITE_FOUNDRY_REDIRECT_URL ?? new URL("/auth/callback", globalThis.location.origin).href;

// This example deliberately opts into persistent browser credentials.
const trackerRuntime = Effect.fn("Tracker.runtime")(function* (owner: string, namespace: string) {
    const runtime = yield* createWebRuntime(owner, namespace, { persistEncryptionKeys: true });
    yield* migrateLinkMetadata(runtime.tables, namespace);
    return runtime;
});

type OpenOntology = CreateOntologyBackendInstallationOptions["openOntology"];

export async function createTrackerInstallations(options?: { openOntology?: OpenOntology }) {
    const foundry = await createFoundryInstallation(options?.openOntology);
    try {
        const sqlite = await createSqliteInstallation(options?.openOntology);
        return { foundry, sqlite };
    } catch (cause) {
        await foundry.cleanup();
        throw cause;
    }
}

export function createTrackerInstallation(installationId: string): Promise<OntologyBackendInstallation> {
    if (installationId === "issue-tracker-sqlite") return createSqliteInstallation();
    if (installationId === new URL(FOUNDRY_URL).origin) return createFoundryInstallation();
    throw new Error("Unknown ontology installation.");
}

async function createFoundryInstallation(openOntology?: OpenOntology) {
    const foundryUsers = createFoundryUsersIntegration({
        objectType: "User",
        lens: foundryUserToUser,
    });

    return createFoundryBackendInstallation({
        baseUrl: FOUNDRY_URL,
        runtime: trackerRuntime,
        openOntology: openOntology,
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
                persistObjects: true,
                writes,
            }),
        ],
    });
}

async function createSqliteInstallation(openOntology?: OpenOntology) {
    return createOntologyBackendInstallation<typeof authClient>({
        installationId: "issue-tracker-sqlite",
        connections: createBetterAuthConnectionAdapter({
            client: authClient,
        }),
        runtime: trackerRuntime,
        openOntology: openOntology,
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
                    persistObjects: true,
                    writes,
                }),
            },
        ],
    });
}
