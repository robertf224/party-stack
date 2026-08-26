import { createBetterAuthConnectionAdapter } from "@party-stack/better-auth";
import { type ConnectionState } from "@party-stack/connections";
import { createFoundryBackendInstallation, createFoundryOntologyRoute } from "@party-stack/foundry-ontology";
import { createFoundryUsersIntegration } from "@party-stack/foundry-ontology/users";
import {
    createOntologyBackendInstallation,
    type LiveOntology,
    type OntologyBackendInstallation,
} from "@party-stack/ontology";
import { createRemoteOntologyBackend } from "@party-stack/remote-ontology/client";
import { createHttpRemoteOntologyTransport } from "@party-stack/remote-ontology/http";
import { createWebRuntime } from "@party-stack/web-runtime";
import { eq } from "@tanstack/db";
import ontology from "../ontology/ontology";
import type { IssueTrackerOntology } from "../ontology/generated/types";
import { foundryUserToUser } from "../ontology/user";
import { authClient } from "./auth";

export type ProfileKind = "foundry" | "sqlite";
export type TrackerOntology = LiveOntology<IssueTrackerOntology>;

export interface ConnectedProfile {
    id: string;
    kind: ProfileKind;
    label: string;
    ontology: TrackerOntology;
}

interface ProfileHandle {
    installation: OntologyBackendInstallation;
    userId: string;
    ontologyId: string;
}

const writes = {
    defaultMode: "outbox" as const,
    defaultVisibility: "optimistic" as const,
};

const FOUNDRY_URL = import.meta.env.NEXT_PUBLIC_FOUNDRY_URL;
const FOUNDRY_ONTOLOGY_RID = import.meta.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID;
const FOUNDRY_CLIENT_ID = import.meta.env.NEXT_PUBLIC_FOUNDRY_CLIENT_ID;
const FOUNDRY_REDIRECT_URL =
    import.meta.env.NEXT_PUBLIC_FOUNDRY_REDIRECT_URL ??
    (typeof window === "undefined"
        ? "http://localhost:3000/auth/callback"
        : `${window.location.origin}/auth/callback`);

const handles = new Map<string, ProfileHandle>();
let foundryOAuthCompletion: Promise<ConnectedProfile | undefined> | undefined;

const foundryUsers = createFoundryUsersIntegration({
    objectType: "User",
    lens: foundryUserToUser,
});

const foundryInstallation = await createFoundryBackendInstallation({
    baseUrl: FOUNDRY_URL,
    runtime: createWebRuntime,
    connections: {
        token: import.meta.env.NEXT_PUBLIC_FOUNDRY_TOKEN,
        oauth: FOUNDRY_CLIENT_ID
            ? {
                  clientId: FOUNDRY_CLIENT_ID,
                  redirectUrl: FOUNDRY_REDIRECT_URL,
                  // The web runtime does not yet provide a secure
                  // SecretStore. This is acceptable only for the demo.
                  dangerouslyPersistSecrets: true,
                  scopes: [
                      "api:admin-read",
                      "api:use-ontologies-read",
                      "api:use-ontologies-write",
                      "api:use-mediasets-read",
                      "api:use-mediasets-write",
                      "offline_access",
                  ],
              }
            : undefined,
    },
    routes: [
        createFoundryOntologyRoute({
            ontologyId: FOUNDRY_ONTOLOGY_RID,
            ir: ontology,
            users: foundryUsers,
            writes,
        }),
    ],
});

const sqliteInstallation = await createOntologyBackendInstallation<typeof authClient>({
    installationId: "issue-tracker-sqlite",
    connections: createBetterAuthConnectionAdapter({
        client: authClient,
    }),
    runtime: createWebRuntime,
    routes: [
        {
            matches: (ontologyId) => ontologyId === "issue-tracker",
            configure: ({ egress }) => ({
                ir: ontology,
                backend: createRemoteOntologyBackend({
                    transport: createHttpRemoteOntologyTransport({
                        url: "/api/remote-ontology/",
                        fetch: egress.fetch,
                        ir: ontology,
                    }),
                }),
                persistObjects: false,
                writes,
            }),
        },
    ],
});

async function openProfile(options: {
    installation: OntologyBackendInstallation;
    userId: string;
    ontologyId: string;
    kind: ProfileKind;
    label: string;
    id?: string;
}): Promise<ConnectedProfile> {
    const ontology = await options.installation.openOntology<IssueTrackerOntology>({
        userId: options.userId,
        ontologyId: options.ontologyId,
    });
    const id = options.id ?? `${options.installation.installationId}:${options.userId}:${options.ontologyId}`;
    handles.set(id, {
        installation: options.installation,
        userId: options.userId,
        ontologyId: options.ontologyId,
    });
    return {
        id,
        kind: options.kind,
        label: options.label,
        ontology,
    };
}

const foundryProfile = (userId: string) =>
    openProfile({
        installation: foundryInstallation,
        userId,
        ontologyId: FOUNDRY_ONTOLOGY_RID,
        kind: "foundry",
        label: "Foundry",
    });

const sqliteProfile = (userId: string) =>
    openProfile({
        installation: sqliteInstallation,
        userId,
        ontologyId: "issue-tracker",
        kind: "sqlite",
        label: "SQLite",
        id: `sqlite:${userId}`,
    });

export async function connectSqliteProfile(credentials: {
    username: string;
    password: string;
}): Promise<ConnectedProfile> {
    const result = await sqliteInstallation.authentication.signIn.email({
        email: credentials.username,
        password: credentials.password,
    });
    if (result.error || !result.data) {
        throw new Error(result.error?.message ?? "Better Auth sign-in failed.");
    }
    return sqliteProfile(result.data.user.id);
}

export async function connectGoogleProfile(): Promise<ConnectedProfile> {
    const result = await sqliteInstallation.authentication.signIn.popup({
        provider: "google",
    });
    if (result.error) {
        throw new Error(result.error.message ?? "Google sign-in failed.");
    }
    const listed = await sqliteInstallation.authentication.multiSession.listDeviceSessions();
    if (listed.error || !listed.data) {
        throw new Error(listed.error?.message ?? "Could not load the Google session.");
    }
    const selected = [...listed.data].sort(
        (left, right) =>
            new Date(right.session.updatedAt).getTime() - new Date(left.session.updatedAt).getTime()
    )[0];
    if (!selected) {
        throw new Error("Google sign-in did not create a session.");
    }
    return sqliteProfile(selected.user.id);
}

export async function connectFoundryProfile(): Promise<ConnectedProfile> {
    const connection = await foundryInstallation.authentication.signIn.oauth({
        browserPresentation: "popup",
    });
    return foundryProfile(connection.userId);
}

async function completeFoundryOAuthRedirectInternal(url: string): Promise<ConnectedProfile | undefined> {
    const connection = await foundryInstallation.authentication.completeOAuthRedirect(url);
    if (!connection) return;
    const id = `${foundryInstallation.installationId}:${connection.userId}:${FOUNDRY_ONTOLOGY_RID}`;
    const existing = initialProfiles.find((profile) => profile.id === id);
    if (existing) return existing;
    const profile = await foundryProfile(connection.userId);
    initialProfiles.push(profile);
    return profile;
}

export function completeFoundryOAuthRedirect(url: string): Promise<ConnectedProfile | undefined> {
    foundryOAuthCompletion ??= completeFoundryOAuthRedirectInternal(url).catch((error: unknown) => {
        foundryOAuthCompletion = undefined;
        throw error;
    });
    return foundryOAuthCompletion;
}

export async function disconnectProfile(profile: ConnectedProfile): Promise<void> {
    const handle = handles.get(profile.id);
    if (!handle) return;
    handles.delete(profile.id);
    await handle.installation.disconnect(handle.userId);
}

export function subscribeProfileConnection(
    profile: ConnectedProfile,
    listener: (state: ConnectionState) => void
): () => void {
    const handle = handles.get(profile.id);
    if (!handle) return () => undefined;
    const connections = handle.installation.connections;
    const subscription = connections.subscribeChanges(
        () => {
            listener(
                connections.get(handle.userId)?.state ?? {
                    status: "inactive",
                }
            );
        },
        {
            where: (connection) => eq(connection.userId, handle.userId),
        }
    );
    return () => subscription.unsubscribe();
}

const initialProfiles = [
    ...(await Promise.all(
        [...foundryInstallation.connections.values()]
            .filter((connection) => connection.state.status === "active")
            .map((connection) => foundryProfile(connection.userId))
    )),
    ...(await Promise.all(
        [...sqliteInstallation.connections.values()]
            .filter((connection) => connection.state.status === "active")
            .map((connection) => sqliteProfile(connection.userId))
    )),
];

export function getIssueTrackerProfiles(): ConnectedProfile[] {
    return [...initialProfiles];
}
