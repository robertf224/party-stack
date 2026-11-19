import type { bulkLoadOntologyEntities } from "@osdk/client.unstable";
import type { OntologyClient } from "@party-stack/foundry-client";

type ConjureContext = Parameters<typeof bulkLoadOntologyEntities>[0];

/** A conjure-lite context for Foundry's ontology metadata service (OMS).
 *
 * conjure-lite authenticates only through `fetchFn` and `tokenProvider`; it ignores `fetch`,
 * so spreading a client sends OMS requests with the global, anonymous fetch. The client's
 * `fetch` always carries its credentials, and an authenticated-egress client's
 * `tokenProvider` rejects by design, so only `fetchFn` is passed.
 */
export function ontologyMetadataContext(client: OntologyClient): ConjureContext {
    return {
        baseUrl: new URL(client.baseUrl).origin,
        servicePath: "/ontology-metadata/api",
        fetchFn: client.fetch,
    };
}
