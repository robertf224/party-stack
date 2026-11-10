import { toWebEgress } from "@party-stack/connect";
import { createSalesforceClient } from "@party-stack/salesforce-client";
import { Effect } from "effect";
import { makeSalesforceOntologyBackend } from "./adapter/makeSalesforceOntologyBackend.js";
import { makeSalesforceMetadataBackend as makeMetadataBackend } from "./meta/backend.js";
import type { SalesforceMetadataBackendOptions } from "./meta/backend.js";
import type { ConnectionEgress } from "@party-stack/connect";
import type { OntologyIR } from "@party-stack/ontology-spec";

export interface SalesforceConnectionClientOptions {
    instanceUrl: string;
    apiVersion: string;
    egress: ConnectionEgress;
}
export const makeSalesforceConnectionClient = Effect.fnUntraced(function* (
    options: SalesforceConnectionClientOptions
) {
    const web = yield* toWebEgress(options.egress);
    return createSalesforceClient({
        instanceUrl: options.instanceUrl,
        apiVersion: options.apiVersion,
        authenticatedFetch: true,
        fetch: web.fetch,
    });
});
export const makeSalesforceBackend = Effect.fnUntraced(function* (
    options: SalesforceConnectionClientOptions & { ir: OntologyIR; context: Record<string, unknown> }
) {
    return yield* makeSalesforceOntologyBackend({
        ir: options.ir,
        client: yield* makeSalesforceConnectionClient(options),
        context: options.context,
    });
});
export const makeSalesforceMetadataBackend = Effect.fnUntraced(function* (
    options: SalesforceConnectionClientOptions & Omit<SalesforceMetadataBackendOptions, "client">
) {
    return makeMetadataBackend({
        ...options,
        client: yield* makeSalesforceConnectionClient(options),
    });
});
