import { Collection, createCollection } from "@tanstack/db";
import { applyActionLogic } from "./applyActionLogic.js";
import { resolveActionParameters } from "./expression.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";

export type OntologyObject = Record<string, unknown>;
export interface OntologyDefinition {
    objectTypes: Record<string, OntologyObject>;
    actionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
        }
    >;
}

export type OntologyCollection<T extends OntologyObject> = Collection<T>;

export interface LiveOntologyActionExecution {
    mutationFn: () => Promise<void>;
    mutator: () => void;
}

export type LiveOntologyAction<Parameters extends Record<string, unknown> = Record<string, unknown>> = (
    parameters: Parameters
) => LiveOntologyActionExecution;

export type LiveOntologyObjects<
    ObjectTypes extends OntologyDefinition["objectTypes"] = OntologyDefinition["objectTypes"],
> = {
    [ObjectTypeName in keyof ObjectTypes]: OntologyCollection<ObjectTypes[ObjectTypeName]>;
};

export type LiveOntologyActions<ActionTypes extends OntologyDefinition["actionTypes"]> = {
    [ActionTypeName in keyof ActionTypes]: LiveOntologyAction<ActionTypes[ActionTypeName]["parameters"]>;
};

export interface LiveOntology<Ontology extends OntologyDefinition = OntologyDefinition> {
    objects: LiveOntologyObjects<Ontology["objectTypes"]>;
    actions: LiveOntologyActions<Ontology["actionTypes"]>;
    cleanup: () => Promise<void>;
}

export interface LiveOntologyOpts {
    ir: OntologyIR;
    adapter: OntologyAdapter;
    getContext?: () => Record<string, unknown>;
}

export function createLiveOntology<Ontology extends OntologyDefinition = OntologyDefinition>(
    opts: LiveOntologyOpts
): LiveOntology<Ontology> {
    const objects = Object.fromEntries(
        opts.ir.objectTypes.map((objectType) => {
            const collectionOptions = opts.adapter.getCollectionOptions(objectType.name);
            const collection = createCollection({
                ...collectionOptions,
                getKey: (object) =>
                    (object as Record<string, string | number>)[objectType.primaryKey] as string | number,
            }) as OntologyCollection<OntologyObject>;

            return [objectType.name, collection];
        })
    ) as Record<string, OntologyCollection<OntologyObject>>;
    const actions = Object.fromEntries(
        opts.ir.actionTypes.map((action) => [
            action.name,
            (providedParameters: Record<string, unknown>) => {
                const context = opts.getContext?.() ?? {};
                const parameters = resolveActionParameters(
                    opts.ir,
                    action.name,
                    providedParameters,
                    context,
                    objects
                );

                return {
                    mutationFn: async () => {
                        await opts.adapter.applyAction(action.name, parameters, {
                            objects: objects as Record<string, Collection<Record<string, unknown>>>,
                        });
                    },
                    mutator: () => {
                        applyActionLogic({
                            ir: opts.ir,
                            actionTypeName: action.name,
                            parameters,
                            context,
                            objects,
                        });
                    },
                };
            },
        ])
    );

    return {
        objects: objects as unknown as LiveOntologyObjects<Ontology["objectTypes"]>,
        actions: actions as unknown as LiveOntologyActions<Ontology["actionTypes"]>,
        cleanup: async () => {
            await Promise.all(Object.values(objects).map((collection) => collection.cleanup()));
            await opts.adapter.cleanup?.();
        },
    };
}
