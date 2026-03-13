import { invariant } from "@bobbyfidz/panic";
import { Client, createClient } from "@osdk/client";
import { createConfidentialOauthClient } from "@osdk/oauth";

export function createFoundryClient(): Client {
    invariant(process.env.FOUNDRY_URL, "FOUNDRY_URL");
    invariant(process.env.FOUNDRY_CLIENT_ID, "FOUNDRY_CLIENT_ID");
    invariant(process.env.FOUNDRY_CLIENT_SECRET, "FOUNDRY_CLIENT_SECRET");
    invariant(process.env.FOUNDRY_ONTOLOGY_RID, "FOUNDRY_ONTOLOGY_RID");

    const auth = createConfidentialOauthClient(
        process.env.FOUNDRY_CLIENT_ID,
        process.env.FOUNDRY_CLIENT_SECRET,
        process.env.FOUNDRY_URL
    );
    return createClient(process.env.FOUNDRY_URL, process.env.FOUNDRY_ONTOLOGY_RID, auth);
}

let client: Client | undefined;
export function getFoundryClient() {
    if (!client) {
        client = createFoundryClient();
    }
    return client;
}
