import { Collection, createCollection } from "@tanstack/db";
import type { OntologyIR } from "./ir/index.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";

type OntologyObject = Record<string, unknown>;
export interface OntologyDefinition {
    objectTypes: Record<string, OntologyObject>;
}

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

export type LiveOntologyObjects<ObjectTypes extends OntologyDefinition["objectTypes"]> = {
    [ObjectTypeName in keyof ObjectTypes]: OntologyCollection<ObjectTypes[ObjectTypeName]>;
};

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
}

export interface LiveOntologyOpts {
    ir: OntologyIR;
    adapter: OntologyAdapter;
}

export function createLiveOntology<Ontology extends OntologyDefinition = OntologyDefinition>(
    opts: LiveOntologyOpts
): LiveOntology<Ontology> {
    const objects = Object.fromEntries(
        opts.ir.objectTypes.map((objectType) => {
            const collection = createCollection({
                sync: opts.adapter.getSyncConfig(objectType.name),
                getKey: (object) => {
                    const key = (object as Record<string, string | number | undefined>)[
                        objectType.primaryKey
                    ];
                    if (key === undefined) {
                        throw new Error(
                            `Primary key "${objectType.primaryKey}" is missing on an object in "${objectType.name}".`
                        );
                    }
                    return key;
                },
            }) as OntologyCollection<OntologyObject>;

            return [objectType.name, collection];
        })
    );

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
    };
}
