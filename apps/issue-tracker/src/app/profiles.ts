import { type ConnectionState } from "@party-stack/connect";
import { authClient } from "./auth";
import { openSharedInstallation } from "./sharedOntology";
import { FOUNDRY_INSTALLATION_ID, FOUNDRY_ONTOLOGY_RID } from "./trackerConfig";
import type { IssueTrackerOntology } from "../ontology/generated/types";
import type { FoundryAuthenticationClient } from "@party-stack/foundry-ontology";
import type { LiveOntology, OntologyBackendInstallation } from "@party-stack/ontology";
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

const handles = new Map<string, ProfileHandle>();
const foundryOAuthCompletions = new Map<string, Promise<ConnectedProfile | undefined>>();
const foundryInstallation = await openSharedInstallation<FoundryAuthenticationClient>(
    FOUNDRY_INSTALLATION_ID,
    true
);
const sqliteInstallation = await openSharedInstallation<typeof authClient>("issue-tracker-sqlite");

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
    const result = await authClient.signIn.popup({
        provider: "google",
    });
    if (result.error) {
        throw new Error(result.error.message ?? "Google sign-in failed.");
    }
    await sqliteInstallation.refreshConnections();
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
    const state = new URL(url).searchParams.get("state") ?? "";
    let completion = foundryOAuthCompletions.get(state);
    if (!completion) {
        completion = completeFoundryOAuthRedirectInternal(url).catch((error: unknown) => {
            foundryOAuthCompletions.delete(state);
            throw error;
        });
        foundryOAuthCompletions.set(state, completion);
        if (foundryOAuthCompletions.size > 4) {
            foundryOAuthCompletions.delete(foundryOAuthCompletions.keys().next().value!);
        }
    }
    return completion;
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
    return handle.installation.connectionMonitor(handle.userId).subscribe(listener);
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
