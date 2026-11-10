import { o, type OntologyIR } from "@party-stack/ontology-spec";

export const FOUNDRY_CURRENT_USER_CONTEXT_FIELD = "userId";

/** Foundry's currentUser action argument is the authenticated provider subject ID. */
export const foundryContext = {
    type: o.struct({
        fields: [{ name: FOUNDRY_CURRENT_USER_CONTEXT_FIELD, displayName: "User ID", type: o.string({}) }],
    }),
    partition: [[FOUNDRY_CURRENT_USER_CONTEXT_FIELD]],
} satisfies NonNullable<OntologyIR["context"]>;
