"use client";

import { createBetterAuthConnectionAdapter } from "@party-stack/better-auth";
import { type ConnectionState } from "@party-stack/connections";
import { eq } from "@tanstack/db";
import {
    createFoundryBackendInstallation,
    createFoundryOntologyRoute,
    type FoundryAuthenticationClient,
} from "@party-stack/foundry-ontology";
import {
    createFoundryAdminOntologyRoute,
    createFoundryUsersIntegration,
} from "@party-stack/foundry-ontology/users";
import {
    createOntologyBackendInstallation,
    type LiveOntology,
    type OntologyBackendInstallation,
} from "@party-stack/ontology";
import { createRemoteOntologyBackend } from "@party-stack/remote-ontology/client";
import { createHttpRemoteOntologyTransport } from "@party-stack/remote-ontology/http";
import { createWebRuntime } from "@party-stack/web-runtime";
import ontology from "../ontology/ontology";
import type { IssueTrackerOntology, IssueTrackerOntologyContext, User } from "../ontology/generated/types";
import { foundryUserToUser } from "../ontology/user";
import { authClient } from "./auth";

export type ProfileKind = "foundry" | "sqlite";
export type TrackerOntology = LiveOntology<IssueTrackerOntology>;

export interface ConnectedProfile {
    id: string;
    kind: ProfileKind;
    label: string;
    ontology: TrackerOntology;
    user?: User;
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
interface ProfileHandle {
    installation: OntologyBackendInstallation;
    userId: string;
    ontologyId: string;
}

const handles = new Map<string, ProfileHandle>();
let environmentFoundryInstallation: OntologyBackendInstallation<FoundryAuthenticationClient> | undefined;
let foundryOAuthCompletion: Promise<ConnectedProfile | undefined> | undefined;

function foundryRoutes(baseUrl: string, ontologyRid: string) {
    const users = () =>
        createFoundryUsersIntegration({
            objectType: "User",
            lens: foundryUserToUser,
        });
    return [
        createFoundryAdminOntologyRoute({
            baseUrl,
        }),
        createFoundryOntologyRoute({
            ontologyId: ontologyRid,
            baseUrl,
            ir: ontology,
            users,
            persistObjects: true,
            writes,
        }),
    ];
}

async function foundryProfile(
    installation: OntologyBackendInstallation,
    userId: string,
    ontologyId: string,
    label: string
): Promise<ConnectedProfile> {
    const connection = installation.connections.get(userId);
    if (!connection) {
        throw new Error(`Foundry user "${userId}" has no connection.`);
    }
    const live = await installation.openOntology<IssueTrackerOntology>({
        userId,
        ontologyId,
    });
    const id = `${installation.installationId}:${userId}:${ontologyId}`;
    handles.set(id, {
        installation,
        userId,
        ontologyId,
    });
    return {
        id,
        kind: "foundry",
        label,
        ontology: live,
    };
}

async function createEnvironmentFoundryProfiles(): Promise<ConnectedProfile[]> {
    const baseUrl = FOUNDRY_URL;
    const ontologyRid = FOUNDRY_ONTOLOGY_RID;
    const installation = await createFoundryBackendInstallation({
        baseUrl,
        runtime: createWebRuntime,
        connections: {
            token: import.meta.env.NEXT_PUBLIC_FOUNDRY_TOKEN,
            oauth: FOUNDRY_CLIENT_ID
                ? {
                      clientId: FOUNDRY_CLIENT_ID,
                      redirectUrl: FOUNDRY_REDIRECT_URL,
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
        routes: foundryRoutes(baseUrl, ontologyRid),
    });
    environmentFoundryInstallation = installation;
    return Promise.all(
        [...installation.connections.values()]
            .filter((connection) => connection.state.status === "active")
            .map((connection) => foundryProfile(installation, connection.userId, ontologyRid, "Foundry"))
    );
}

async function createSqliteInstallation() {
    const connectionAdapter = createBetterAuthConnectionAdapter({
        client: authClient,
    });
    return createOntologyBackendInstallation<typeof authClient>({
        installationId: "issue-tracker-sqlite",
        connections: connectionAdapter,
        runtime: createWebRuntime,
        routes: [
            {
                matches: (ontologyId) => ontologyId === "issue-tracker",
                configure: ({ egress }) => {
                    const transport = createHttpRemoteOntologyTransport({
                        url: "/api/remote-ontology/",
                        fetch: egress.fetch,
                        ir: ontology,
                    });
                    return {
                        ir: ontology,
                        backend: createRemoteOntologyBackend({
                            transport,
                        }),
                        persistObjects: false,
                        writes,
                    };
                },
            },
        ],
        createContext: (userId) => ({
            user: userId,
        }),
    });
}

const sqliteInstallation = await createSqliteInstallation();

async function sqliteProfile(userId: string): Promise<ConnectedProfile> {
    const connection = sqliteInstallation.connections.get(userId);
    if (!connection) {
        throw new Error(`SQLite user "${userId}" has no connection.`);
    }
    const live = await sqliteInstallation.openOntology<IssueTrackerOntology>({
        userId,
        ontologyId: "issue-tracker",
    });
    const id = `sqlite:${userId}`;
    handles.set(id, {
        installation: sqliteInstallation,
        userId,
        ontologyId: "issue-tracker",
    });
    return {
        id,
        kind: "sqlite",
        label: "SQLite",
        ontology: live,
    };
}

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
    const installation = environmentFoundryInstallation;
    if (!installation) {
        throw new Error("Foundry backend installation is not initialized.");
    }
    const connection = await installation.authentication.signIn.oauth({
        browserPresentation: "popup",
    });
    return foundryProfile(installation, connection.userId, FOUNDRY_ONTOLOGY_RID, "Foundry");
}

async function completeFoundryOAuthRedirectInternal(url: string): Promise<ConnectedProfile | undefined> {
    const installation = environmentFoundryInstallation;
    if (!installation) {
        throw new Error("Foundry backend installation is not initialized.");
    }
    const connection = await installation.authentication.completeOAuthRedirect(url);
    if (!connection) return;
    const id = `${installation.installationId}:${connection.userId}:${FOUNDRY_ONTOLOGY_RID}`;
    const existing = initialProfiles.find((profile) => profile.id === id);
    if (existing) return existing;
    const profile = await foundryProfile(installation, connection.userId, FOUNDRY_ONTOLOGY_RID, "Foundry");
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
    ...(await createEnvironmentFoundryProfiles()),
    ...(await Promise.all(
        [...sqliteInstallation.connections.values()]
            .filter((connection) => connection.state.status === "active")
            .map((connection) => sqliteProfile(connection.userId))
    )),
];

export function getIssueTrackerProfiles(): ConnectedProfile[] {
    return initialProfiles;
}
