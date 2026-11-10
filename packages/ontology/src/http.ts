import { BackendError } from "@party-stack/ontology-backend";
import { makeOntologyHttpClient } from "@party-stack/ontology-server/rpc/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

export interface HttpClientOptions {
    readonly ontology?: string;
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    readonly fetch?: typeof globalThis.fetch;
}

/** Lazy browser/Fetch binding. createLiveOntology or OntologyProvider owns its Scope. */
export const httpClient = Effect.fnUntraced(function* (url: string | URL, options: HttpClientOptions = {}) {
    const endpoint = yield* Effect.try({
        try: () => new URL(url, globalThis.location?.href).href,
        catch: (cause) =>
            new BackendError({
                operation: "ontology.http",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Supply an absolute endpoint URL outside the browser.",
                cause,
            }),
    });
    return yield* makeOntologyHttpClient({ url: endpoint, ontology: options.ontology }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, {
            headers: options.headers,
            credentials: options.credentials,
        }),
        Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch)
    );
});
