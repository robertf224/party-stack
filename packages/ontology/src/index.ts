// ontology

import { s, TypeDef } from "@party-stack/schema";

// these should prob be defined w/ ontology builders, which should be generated off this meta ontology,
// which should be created by extending schema?

const ObjectType = s.struct({
    fields: [
        {
            name: "displayName",
            displayName: "Display name",
            type: s.string({}),
        },
        {
            name: "pluralDisplayName",
            displayName: "Plural display name",
            type: s.string({}),
        },
        // migrations (probably generated w/ tooling off of schema changes)
        // adapters
        // indexes
    ],
});

type OntologyAdapter = {
    name: string;
    //install: () => Promise<void>;
    //destroy: () => Promise<void>;
    query: () => void; // load subset
    // action (params) =>
};
