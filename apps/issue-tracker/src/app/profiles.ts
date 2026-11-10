import { attachBetterAuthSession } from "@party-stack/better-auth";
import { isUnauthenticatedError } from "@party-stack/ontology-backend";
import { authClient } from "./auth";
import { authentication, openIssueOntology } from "./sharedOntology";
import { FOUNDRY_CLIENT_ID, FOUNDRY_REDIRECT_URL } from "./trackerConfig";
import type { IssueTrackerOntology } from "../ontology/generated/types";
import type { ConnectionState } from "@party-stack/connect";
import type { LiveOntology } from "@party-stack/ontology";
import type { AccountRef } from "@party-stack/ontology/authentication";
export type ProfileKind = "foundry" | "sqlite";
export type TrackerOntology = LiveOntology<IssueTrackerOntology>;

export interface ConnectedProfile {
    id: string;
    kind: ProfileKind;
    label: string;
    ontology: TrackerOntology;
    connection: AccountRef;
}
const foundryOAuth = authentication.oauth({
    applicationId: FOUNDRY_CLIENT_ID,
    redirectUrl: FOUNDRY_REDIRECT_URL,
});
const foundryOAuthCompletions = new Map<string, Promise<ConnectedProfile | undefined>>();

async function openProfile(connection: AccountRef): Promise<ConnectedProfile> {
    const kind = connection.kind === "external-session" ? "sqlite" : "foundry";
    const ontology = await openIssueOntology(connection);
    return {
        id: `${connection.kind}:${connection.id}`,
        kind,
        label: kind === "foundry" ? "Foundry" : "SQLite",
        ontology,
        connection,
    };
}
export async function connectSqliteProfile(credentials: {
    username: string;
    password: string;
}): Promise<ConnectedProfile> {
    const result = await authClient.signIn.email({
        email: credentials.username,
        password: credentials.password,
    });
    if (result.error || !result.data) throw new Error(result.error?.message ?? "Better Auth sign-in failed.");
    return openProfile(
        await attachBetterAuthSession({
            client: authClient,
            authentication,
            serviceInstanceId: "sqlite",
            session: result.data,
        })
    );
}
export async function connectGoogleProfile(): Promise<ConnectedProfile> {
    const result = await authClient.signIn.popup({ provider: "google" });
    if (result.error) throw new Error(result.error.message ?? "Google sign-in failed.");
    // Better Auth's popup result currently contains no session identity. This
    // existing demo heuristic needs explicit selection or an upstream result API.
    const listed = await authClient.multiSession.listDeviceSessions();
    if (listed.error || !listed.data) throw new Error("Could not load the Google session.");
    const selected = [...listed.data].sort(
        (left, right) =>
            new Date(right.session.updatedAt).getTime() - new Date(left.session.updatedAt).getTime()
    )[0];
    if (!selected) throw new Error("Google sign-in did not create a session.");
    return openProfile(
        await attachBetterAuthSession({
            client: authClient,
            authentication,
            serviceInstanceId: "sqlite",
            session: selected.session,
        })
    );
}
export async function connectFoundryProfile(): Promise<ConnectedProfile> {
    const connection = await foundryOAuth.signIn({ browserPresentation: "popup" });
    return openProfile(connection);
}
async function completeFoundryOAuthRedirectInternal(url: string): Promise<ConnectedProfile | undefined> {
    const connection = await foundryOAuth.complete(url);
    if (!connection) return;
    const ref = connection;
    const existing = initialProfiles.find(
        (profile) => profile.connection.kind === ref.kind && profile.connection.id === ref.id
    );
    if (existing) return existing;
    const profile = await openProfile(ref);
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
        if (foundryOAuthCompletions.size > 4)
            foundryOAuthCompletions.delete(foundryOAuthCompletions.keys().next().value!);
    }
    return completion;
}
export async function disconnectProfile(profile: ConnectedProfile): Promise<void> {
    await authentication.signOut(profile.connection);
    await profile.ontology.cleanup();
}
export function subscribeProfileConnection(
    profile: ConnectedProfile,
    listener: (state: ConnectionState) => void
): () => void {
    const monitor = profile.ontology.diagnostics?.parent?.replica;
    if (!monitor) return () => undefined;
    const read = () => {
        const state = monitor.getSnapshot().status?.authentication;
        if (state) listener(state);
    };
    const unsubscribe = monitor.subscribe(read);
    read();
    return unsubscribe;
}
const restored = await authentication.connections();
const initialProfiles = (
    await Promise.all(
        restored
            .filter((connection) => connection.status === "active")
            .map(async (connection) => {
                try {
                    return await openProfile(connection);
                } catch (cause) {
                    // Saved external sessions may have expired or belonged to a reset demo backend.
                    // Leave sign-in available while preserving other usable profiles.
                    if (isUnauthenticatedError(cause)) return undefined;
                    throw cause;
                }
            })
    )
).filter((profile): profile is ConnectedProfile => profile !== undefined);
export function getIssueTrackerProfiles(): ConnectedProfile[] {
    return [...initialProfiles];
}
