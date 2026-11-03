import { makeMetadataBackend } from "@party-stack/ontology-backend/meta";
import { Effect } from "effect";
import type { OntologyBackendAdapter } from "../live/OntologyBackendAdapter.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

export function createLocalMetaOntologyBackendAdapter(ir: OntologyIR): OntologyBackendAdapter {
    return { name: "local-metadata", open: () => Effect.sync(() => makeMetadataBackend(ir)) };
}
