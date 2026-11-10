import { createLiveOntology, createOntologyClient } from "@party-stack/ontology";
import { createAuthenticationClient } from "@party-stack/ontology/authentication";
import { workerClient } from "@party-stack/ontology/worker";
import { webRuntime } from "@party-stack/web-runtime";
import { clientId, redirectUrl, useDevelopmentCredentials } from "./salesforce-config";
import type { SalesforceTaskManagerOntology } from "../ontology/generated/types";
import type { LiveOntology, MetaOntology } from "@party-stack/ontology";
import type { AccountRef } from "@party-stack/ontology/authentication";

const runtime = webRuntime({ storage: "memory" });
let clients: Promise<Awaited<ReturnType<typeof openClients>>> | undefined;
async function openClients() {
    const client = await createOntologyClient(
        workerClient(
            () =>
                new SharedWorker(new URL("./salesforce.worker.ts", import.meta.url), {
                    type: "module",
                    name: "salesforce-task-manager",
                })
        )
    );
    try {
        const authentication = await createAuthenticationClient({ client, runtime });
        return {
            client,
            authentication,
            oauth: authentication.oauth({ applicationId: clientId, redirectUrl }),
        };
    } catch (error) {
        await client.cleanup();
        throw error;
    }
}
function getClients() {
    return (clients ??= openClients().catch((error) => {
        clients = undefined;
        throw error;
    }));
}
let current: SalesforceOntologies | undefined;
export interface SalesforceOntologies {
    data: LiveOntology<SalesforceTaskManagerOntology>;
    meta: LiveOntology<MetaOntology>;
    userId: string;
}
async function openOntologies(connection: AccountRef): Promise<SalesforceOntologies> {
    const { client } = await getClients();
    const objectType = {
        oauth: "OAuthConnection",
        "api-key": "ApiKeyConnection",
        "external-session": "ExternalSessionConnection",
    }[connection.kind];
    const key = `${objectType}/${encodeURIComponent(connection.id)}`;
    const opened = await Promise.allSettled([
        createLiveOntology<SalesforceTaskManagerOntology>({
            client,
            ontology: `data/${key}`,
            runtime,
            writes: { defaultVisibility: "optimistic" },
        }),
        createLiveOntology<MetaOntology>({ client, ontology: `metadata/${key}`, runtime }),
    ]);
    if (opened[0].status === "rejected" || opened[1].status === "rejected") {
        await Promise.allSettled(
            opened.flatMap((result) => (result.status === "fulfilled" ? [result.value.cleanup()] : []))
        );
        throw opened[0].status === "rejected"
            ? opened[0].reason
            : (opened[1] as PromiseRejectedResult).reason;
    }
    const data = opened[0].value;
    const meta = opened[1].value;
    const previous = current;
    current = { data, meta, userId: String(data.context.user) };
    if (previous) await Promise.allSettled([previous.data.cleanup(), previous.meta.cleanup()]);
    return current;
}
async function developmentConnection() {
    const response = await fetch("/__salesforce/dev-session", { method: "POST" });
    if (!response.ok) throw new Error(`Development Salesforce session failed (${response.status}).`);
    const result = (await response.json()) as { accessToken?: unknown };
    if (typeof result.accessToken !== "string")
        throw new Error("Development Salesforce session returned an invalid response.");
    return (await getClients()).authentication.connectApiKey("salesforce", result.accessToken);
}
export async function restoreSalesforceOntologies(): Promise<SalesforceOntologies | undefined> {
    const { authentication } = await getClients();
    const saved = (await authentication.connections()).find((row) => row.status === "active");
    return saved
        ? openOntologies(saved)
        : useDevelopmentCredentials
          ? openOntologies(await developmentConnection())
          : undefined;
}
export async function connectSalesforce(): Promise<SalesforceOntologies> {
    const { oauth } = await getClients();
    const selected = useDevelopmentCredentials
        ? await developmentConnection()
        : await oauth.signIn({ browserPresentation: "popup" });
    return openOntologies(selected);
}
export async function completeSalesforceOAuthRedirect(
    url: string
): Promise<SalesforceOntologies | undefined> {
    const { oauth } = await getClients();
    const selected = await oauth.complete(url);
    return selected ? openOntologies(selected) : undefined;
}
const cleanup = async () => {
    if (current) await Promise.allSettled([current.data.cleanup(), current.meta.cleanup()]);
    current = undefined;
    const opened = await clients?.catch(() => undefined);
    await opened?.authentication.cleanup();
    await opened?.client.cleanup();
    clients = undefined;
};
window.addEventListener(
    "pagehide",
    () => {
        void cleanup();
    },
    { once: true }
);
if (import.meta.hot) import.meta.hot.dispose(cleanup);
