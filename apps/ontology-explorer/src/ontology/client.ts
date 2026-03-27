import { createOntologyClient, type OntologyClient } from "@party-stack/foundry-ontology";

let _client: OntologyClient | undefined;

export function getClient(): OntologyClient {
    if (!_client) {
        _client = createOntologyClient({
            baseUrl: import.meta.env.VITE_FOUNDRY_URL!,
            ontologyRid: import.meta.env.VITE_FOUNDRY_ONTOLOGY_RID!,
            tokenProvider: () => Promise.resolve(import.meta.env.VITE_FOUNDRY_TOKEN!),
        });
    }
    return _client;
}
