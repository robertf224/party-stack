/* eslint-disable @typescript-eslint/no-unused-vars */
import {
    Actions,
    ActionTypeFullMetadata,
    LogicRuleArgument,
    StructFieldArgument,
} from "@osdk/foundry.ontologies";
import { Collection, createOptimisticAction } from "@tanstack/db";
import { OntologyClient } from "../utils/client";

function getProperties(rule: {
    propertyArguments: Record<string, LogicRuleArgument>;
    structPropertyArguments: Record<string, Record<string, StructFieldArgument>>;
}): Record<string, unknown> {
    const properties = {};

    return properties;
}

export function createAction<Parameters extends Record<string, unknown>>(opts: {
    client: OntologyClient;
    actionType: ActionTypeFullMetadata;
    objectCollections: Record<string, Collection>;
}) {
    return createOptimisticAction<Parameters>({
        onMutate: (parameters) => {
            const optimisticRules = opts.actionType.fullLogicRules.filter(
                (rule) =>
                    rule.type === "createObject" ||
                    rule.type === "modifyObject" ||
                    rule.type === "deleteObject" ||
                    rule.type === "createOrModifyObjectV2"
            );
            for (const rule of optimisticRules) {
                switch (rule.type) {
                    case "createObject": {
                        const collection = opts.objectCollections[rule.objectTypeApiName]!;
                        collection.insert(getProperties(rule));
                        break;
                    }
                    case "modifyObject": {
                        const collection = opts.objectCollections[rule.objectToModify];
                    }
                }
            }
        },
        mutationFn: async (parameters) => {
            const { edits } = await Actions.apply(
                opts.client,
                opts.client.ontologyRid,
                opts.actionType.actionType.apiName,
                {
                    parameters,
                    options: { mode: "VALIDATE_AND_EXECUTE", returnEdits: "ALL_V2_WITH_DELETIONS" },
                }
            );
            // actually request final objects
            // loop through edits and write them directly to collection
        },
    });
}

// in optimisticAction, optimistic update is discarded when mutationFn completes.
// we're supposed to make sure collection syncs in the new data before mutationFn completes?

// if not a function-backed action, we provide the optimistic flag

// objectCollections: Record<string, ObjectCollection>
