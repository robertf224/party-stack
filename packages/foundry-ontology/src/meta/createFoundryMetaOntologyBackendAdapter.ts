import { Effect } from "effect";
import { makeFoundryMetadataBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyBackendAdapter } from "@party-stack/ontology";

export interface CreateFoundryMetaOntologyBackendAdapterOpts {
    client: OntologyClient;
    /** Polling interval in milliseconds, or false to disable polling. Defaults to no polling. */
    refetchInterval?: number | false;
}

export function createFoundryMetaOntologyBackendAdapter(
    opts: CreateFoundryMetaOntologyBackendAdapterOpts
): OntologyBackendAdapter {
    return { name: "foundry-metadata", open: () => Effect.succeed(makeFoundryMetadataBackend(opts)) };
}
