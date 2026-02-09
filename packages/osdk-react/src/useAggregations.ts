"use client";

import {
    QueryClient,
    useSuspenseQuery,
    UseSuspenseQueryOptions,
    UseSuspenseQueryResult,
} from "@tanstack/react-query";
import { OntologyObservation, ObjectSet } from "./ontology";
import { useOsdkContext } from "./OsdkContext";
import type {
    AggregateOpts,
    AggregationsResults,
    ObjectOrInterfaceDefinition,
    WhereClause,
    AggregateOptsThatErrorsAndDisallowsOrderingWithMultipleGroupBy,
} from "@osdk/api";

const QUERY_KEY_PREFIX = ["osdk", "aggregations"];

export function useAggregations<
    T extends ObjectOrInterfaceDefinition,
    AO extends AggregateOpts<T>,
    R extends AggregationsResults<T, AO>,
>(
    type: T,
    opts: {
        $where?: WhereClause<T>;
    } & AggregateOptsThatErrorsAndDisallowsOrderingWithMultipleGroupBy<T, AO>,
    queryOpts?: Omit<
        UseSuspenseQueryOptions<AggregationsResults<T, AO> | null, Error, R>,
        "queryKey" | "queryFn" | "initialData" | "initialDataUpdatedAt"
    >
): UseSuspenseQueryResult<AggregationsResults<T, AO>> {
    const { client } = useOsdkContext();
    const { $where, ...aggregateOpts } = opts;
    const objectSet: ObjectSet<T> = {
        type,
        filter: $where,
    };
    return useSuspenseQuery({
        ...queryOpts,
        queryFn: () =>
            ObjectSet.toOSDK(objectSet, client).aggregate(
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
                aggregateOpts as any
            ) as unknown as AggregationsResults<T, AO>,
        queryKey: [...QUERY_KEY_PREFIX, objectSet, aggregateOpts],
    });
}

export function updateAggregationQueries(queryClient: QueryClient, observation: OntologyObservation) {
    const queries = queryClient.getQueryCache().findAll({ queryKey: QUERY_KEY_PREFIX });
    queries.forEach((query) => {
        const [, , objectSet] = query.queryKey as [
            "osdk",
            "aggregations",
            ObjectSet<ObjectOrInterfaceDefinition>,
        ];

        // TODO: do more fine-grained invalidation / updating + work for interfaces.
        if (
            observation.knownObjects.some((object) => object.$objectType === objectSet.type.apiName) ||
            observation.deletedObjects.some((object) => object.objectType === objectSet.type.apiName)
        ) {
            void queryClient.invalidateQueries({ queryKey: query.queryKey });
        }
    });
}
