import { toWebEgress } from "@party-stack/connect";
import { createOntologyClient } from "@party-stack/foundry-client";
import { Effect } from "effect";
import { makeFoundryOntologyBackend } from "./adapter/makeFoundryOntologyBackend.js";
import { makeFoundryMetadataBackend as makeMetadataBackend } from "./meta/backend.js";
import type { FoundryUsersIntegration } from "./adapter/makeFoundryOntologyBackend.js";
import type { ConnectionEgress } from "@party-stack/connect";
import type { OntologyIR } from "@party-stack/ontology-spec";

export type { FoundryOAuthConnectionOptions } from "./connectionOptions.js";

/** Use the selected Connect egress; credentials remain at its authority. */
export const makeFoundryConnectionClient = Effect.fnUntraced(function* (options: {
    baseUrl: string;
    ontologyId: string;
    egress: ConnectionEgress;
}) {
    const web = yield* toWebEgress(options.egress);
    return createOntologyClient({
        baseUrl: options.baseUrl,
        ontologyRid: options.ontologyId,
        fetch: web.fetch,
        createWebSocket: web.createWebSocket,
    });
});
export const makeFoundryBackend = Effect.fnUntraced(function* (options: {
    baseUrl: string;
    ontologyId: string;
    egress: ConnectionEgress;
    ir: OntologyIR;
    context: Record<string, unknown>;
    users?: FoundryUsersIntegration;
    watch?: boolean;
}) {
    return yield* makeFoundryOntologyBackend({
        ...options,
        client: yield* makeFoundryConnectionClient(options),
        context: options.context,
    });
});
export const makeFoundryMetadataBackend = Effect.fnUntraced(function* (options: {
    baseUrl: string;
    ontologyId: string;
    egress: ConnectionEgress;
    refetchInterval?: number | false;
}) {
    return makeMetadataBackend({
        client: yield* makeFoundryConnectionClient(options),
        refetchInterval: options.refetchInterval,
    });
});

export { makeFoundryServiceConnector } from "./serviceConnector.js";
