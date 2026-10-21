import { Effect } from "effect";
import { makeSalesforceMetadataBackend } from "./backend.js";
import type { SalesforceCrudActionTypeSelection } from "../crud.js";
import type { OntologyBackendAdapter } from "@party-stack/ontology";
import type { SalesforceClient } from "@party-stack/salesforce-client";

export interface CreateSalesforceMetaOntologyBackendAdapterOpts {
    client: SalesforceClient;
    /**
     * Optional allowlist of sObject API names for metadata loading.
     * Useful for scoped form pulls without describing the entire org.
     */
    objectTypeNames?: string[];
    /** Optional allowlist of autolaunched Flow API names. */
    flowActionTypeNames?: string[];
    /** Standard Salesforce operations modeled as mutating actions. */
    standardActionTypeNames?: string[];
    /** Standard Salesforce operations modeled as query functions. */
    standardQueryFunctionTypeNames?: string[];
    /** Explicit CRUD actions to synthesize from sObject describe metadata. */
    crudActionTypes?: readonly SalesforceCrudActionTypeSelection[];
}

export function createSalesforceMetaOntologyBackendAdapter(
    opts: CreateSalesforceMetaOntologyBackendAdapterOpts
): OntologyBackendAdapter {
    return { name: "salesforce-metadata", open: () => Effect.succeed(makeSalesforceMetadataBackend(opts)) };
}
