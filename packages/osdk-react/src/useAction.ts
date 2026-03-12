import { ActionError } from "@bobbyfidz/osdk-utils";
import { useMutation, UseMutationResult, UseMutationOptions, useQueryClient } from "@tanstack/react-query";
import { ActionEdits, ActionParameters, OntologyObservation } from "./ontology";
import { useOsdkContext } from "./OsdkContext";
import { updateAggregationQueries } from "./useAggregations";
import { updateObjectQueries } from "./useObject";
import { updateObjectsQueries } from "./useObjects";
import type { ActionDefinition, ActionEditResponse } from "@osdk/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useAction<T extends ActionDefinition<any>>(
    type: T,
    mutationOpts?: Omit<
        UseMutationOptions<ActionEdits, ActionError, ActionParameters<T>>,
        "mutationFn" | "mutationKey"
    >
): UseMutationResult<ActionEdits, ActionError, ActionParameters<T>> {
    const { client } = useOsdkContext();
    const queryClient = useQueryClient();
    return useMutation({
        ...mutationOpts,
        mutationFn: async (parameters) => {
            // Not sure why we need this cast and such here.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            const result = (await client(type).applyAction(parameters, {
                $returnEdits: true,
            })) as ActionEditResponse;
            const createdObjectsReferences = result.addedObjects ?? [];
            const modifiedObjectsReferences = result.modifiedObjects ?? [];
            // Wish there were a better way to get heterogenous lists of objects in OSDK...
            const createdObjectsPromise = Promise.all(
                createdObjectsReferences.map((reference) =>
                    client({ type: "object", apiName: reference.objectType }).fetchOne(reference.primaryKey)
                )
            );
            const modifiedObjectsPromise = Promise.all(
                modifiedObjectsReferences.map((reference) =>
                    client({ type: "object", apiName: reference.objectType }).fetchOne(reference.primaryKey)
                )
            );
            const [createdObjects, modifiedObjects] = await Promise.all([
                createdObjectsPromise,
                modifiedObjectsPromise,
            ]);
            return {
                createdObjects,
                modifiedObjects,
                deletedObjects: result.deletedObjects ?? [],
            };
        },
        onSuccess: (data, variables, onMutateResult, context) => {
            const observation: OntologyObservation = {
                knownObjects: [...data.createdObjects, ...data.modifiedObjects],
                deletedObjects: data.deletedObjects,
            };
            updateObjectQueries(queryClient, observation);
            updateObjectsQueries(queryClient, observation);
            updateAggregationQueries(queryClient, observation);
            mutationOpts?.onSuccess?.(data, variables, onMutateResult, context);
        },
    });
}
