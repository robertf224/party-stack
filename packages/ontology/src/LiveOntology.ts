import { Collection, createCollection } from "@tanstack/db";
import { OntologyIR } from "./ir/index.js";
import { OntologyAdapter } from "./OntologyAdapter.js";

// TODO: generic types
export interface LiveOntology {
    objectTypes: Record<
        string,
        {
            collection: Collection;
            // TODO: links
        }
    >;
    // TODO: Action types
}

export interface LiveOntologyOpts {
    ir: OntologyIR;
    adapter: OntologyAdapter;
}

// generator can take IR and generate types + adapter-ready builder w/ IR locked in

export function createLiveOntology(opts: LiveOntologyOpts): LiveOntology {
    // TODO: should we just build runtime schemas live here?

    return {
        objectTypes: Object.fromEntries(
            opts.ir.objectTypes.map((objectType) => [
                objectType.apiName,
                {
                    collection: createCollection({
                        sync: opts.adapter.getSyncConfig(objectType.apiName),
                        getKey: (object) => object[objectType.primaryKey] as string | number,
                    }),
                },
            ])
        ),
    };
}
