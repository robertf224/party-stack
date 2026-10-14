import { type LiveOntology, type MetaOntology } from "@party-stack/ontology";
import {
    createSalesforceBackendInstallation,
    createSalesforceOntologyRoute,
} from "@party-stack/salesforce-ontology";
import { createWebRuntime } from "@party-stack/web-runtime";
import ontology from "../ontology/ontology";
import { SALESFORCE_TASK_MANAGER_ONTOLOGY_ID } from "../settings";
import type { SalesforceTaskManagerOntology } from "../ontology/generated/types";

function requiredEnv(name: string, value: string | undefined): string {
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

function browserEnv(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

const instanceUrl = requiredEnv(
    "VITE_SALESFORCE_INSTANCE_URL",
    browserEnv(import.meta.env.VITE_SALESFORCE_INSTANCE_URL)
);
const clientId = requiredEnv(
    "VITE_SALESFORCE_CLIENT_ID",
    browserEnv(import.meta.env.VITE_SALESFORCE_CLIENT_ID)
);
const loginUrl = browserEnv(import.meta.env.VITE_SALESFORCE_LOGIN_URL) ?? instanceUrl;
const apiVersion = browserEnv(import.meta.env.VITE_SALESFORCE_API_VERSION) ?? "65.0";
const redirectUrl =
    browserEnv(import.meta.env.VITE_SALESFORCE_REDIRECT_URL) ?? `${window.location.origin}/auth/callback`;
const useDevelopmentCredentials =
    import.meta.env.DEV && import.meta.env.VITE_SALESFORCE_DEV_CREDENTIALS === true;

const installation = await createSalesforceBackendInstallation({
    instanceUrl,
    apiVersion,
    runtime: createWebRuntime,
    connections: {
        cometdUrl: import.meta.env.DEV
            ? `${window.location.origin}/__salesforce/cometd/${apiVersion}`
            : undefined,
        oauth: {
            clientId,
            redirectUrl,
            loginUrl,
            // Demo-only: Web Runtime does not yet expose a secure
            // browser SecretStore for OAuth refresh tokens.
            dangerouslyPersistSecrets: true,
        },
    },
    routes: [
        createSalesforceOntologyRoute({
            ontologyId: SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
            ir: ontology,
            persistObjects: false,
            writes: {
                // defaultMode: "outbox",
                defaultVisibility: "optimistic",
            },
            crudActionTypes: [
                {
                    objectType: "Task",
                    operations: ["create", "update", "delete"],
                },
            ],
        }),
    ],
});

export interface SalesforceOntologies {
    data: LiveOntology<SalesforceTaskManagerOntology>;
    meta: LiveOntology<MetaOntology>;
    userId: string;
}

async function openOntologies(userId: string): Promise<SalesforceOntologies> {
    const [data, meta] = await Promise.all([
        installation.openOntology<SalesforceTaskManagerOntology>({
            userId,
            ontologyId: SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
        }),
        installation.openMetaOntology({
            userId,
            ontologyId: SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
        }),
    ]);
    return { data, meta, userId };
}

async function connectWithDevelopmentCredentials() {
    const response = await fetch("/__salesforce/dev-session", {
        method: "POST",
    });
    if (!response.ok) {
        throw new Error(`Development Salesforce session failed (${response.status}).`);
    }
    const result = (await response.json()) as {
        accessToken?: unknown;
        userId?: unknown;
    };
    if (typeof result.accessToken !== "string" || typeof result.userId !== "string") {
        throw new Error("Development Salesforce session returned an invalid response.");
    }
    return installation.authentication.signIn.accessToken({
        token: result.accessToken,
        userId: result.userId,
    });
}

export async function restoreSalesforceOntologies(): Promise<SalesforceOntologies | undefined> {
    const connection = [...installation.connections.values()].find(
        (candidate) => candidate.state.status === "active"
    );
    if (connection) {
        return openOntologies(connection.userId);
    }
    if (useDevelopmentCredentials) {
        const developmentConnection = await connectWithDevelopmentCredentials();
        return openOntologies(developmentConnection.userId);
    }
    return undefined;
}

export async function connectSalesforce(): Promise<SalesforceOntologies> {
    const connection = useDevelopmentCredentials
        ? await connectWithDevelopmentCredentials()
        : await installation.authentication.signIn.oauth({
              browserPresentation: "popup",
          });
    return openOntologies(connection.userId);
}

export async function completeSalesforceOAuthRedirect(
    url: string
): Promise<SalesforceOntologies | undefined> {
    const connection = await installation.authentication.completeOAuthRedirect(url);
    return connection ? openOntologies(connection.userId) : undefined;
}
