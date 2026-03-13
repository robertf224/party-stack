"use client";

import {
    InfiniteData,
    QueryClient,
    useQueryClient,
    useSuspenseInfiniteQuery,
    UseSuspenseInfiniteQueryOptions,
    UseSuspenseInfiniteQueryResult,
} from "@tanstack/react-query";
import { ObjectSetOrderBy, OntologyObservation, ObjectSet, ObjectList } from "./ontology";
import { useOsdkContext } from "./OsdkContext";
import { updateObjectQueries } from "./useObject";
import { SortedObjectArray } from "./utils";
import type { ObjectOrInterfaceDefinition, Osdk, PageResult, PrimaryKeyType, WhereClause } from "@osdk/api";

const QUERY_KEY_PREFIX = ["osdk", "objects"];

export function useObjects<T extends ObjectOrInterfaceDefinition>(
    type: T,
    opts: {
        $where?: WhereClause<T>;
        $orderBy: ObjectSetOrderBy<T>;
        $pageSize?: number;
    },
    queryOpts?: Omit<
        UseSuspenseInfiniteQueryOptions,
        | "queryKey"
        | "queryFn"
        | "initialData"
        | "initialDataUpdatedAt"
        | "initialPageParam"
        | "getNextPageParam"
        | "getPreviousPageParam"
        | "select"
    >
): Omit<
    UseSuspenseInfiniteQueryResult,
    "data" | "fetchPreviousPage" | "isFetchingPreviousPage" | "hasPreviousPage" | "isFetchPreviousPageError"
> & {
    data: Osdk<T>[];
} {
    const { client } = useOsdkContext();
    const queryClient = useQueryClient();
    const objectList: ObjectList<T> = {
        objectSet: { type, filter: opts.$where },
        orderBy: opts.$orderBy,
    };
    const { data, ...rest } = useSuspenseInfiniteQuery({
        ...queryOpts,
        queryFn: ({ pageParam: $nextPageToken }) => {
            const objectSet = ObjectSet.toOSDK(objectList.objectSet, client);
            const result = objectSet.fetchPage({
                $orderBy: objectList.orderBy,
                $pageSize: opts.$pageSize,
                $nextPageToken,
            });
            void result.then((page) => {
                const observation: OntologyObservation = {
                    knownObjects: page.data,
                    deletedObjects: [],
                };
                updateObjectQueries(queryClient, observation);
            });
            return result;
        },
        queryKey: [...QUERY_KEY_PREFIX, objectList],
        initialPageParam: undefined,
        getNextPageParam: (lastPage) => lastPage.nextPageToken,
    } as UseSuspenseInfiniteQueryOptions<
        PageResult<Osdk<T>>,
        Error,
        InfiniteData<PageResult<Osdk<T>>>,
        readonly unknown[],
        string | undefined
    >);
    return { data: data.pages.flatMap((page) => page.data), ...rest };
}

export function updateObjectsQueries(queryClient: QueryClient, observation: OntologyObservation) {
    const queries = queryClient.getQueryCache().findAll({ queryKey: QUERY_KEY_PREFIX });
    queries.forEach((query) => {
        const [, , objectList] = query.queryKey as [
            "osdk",
            "objects",
            ObjectList<ObjectOrInterfaceDefinition>,
        ];

        if (query.state.fetchStatus === "fetching") {
            return;
        }

        const queryData = query.state.data as InfiniteData<PageResult<Osdk<ObjectOrInterfaceDefinition>>>;
        const flattenedData = new SortedObjectArray(
            queryData.pages.flatMap((page) => page.data),
            (object) => object.$primaryKey,
            ObjectList.getComparator(objectList)
        );
        const hasMore = queryData.pages[queryData.pages.length - 1]?.nextPageToken !== undefined;
        let dirty = false;
        for (const object of observation.knownObjects) {
            const normalizedObject = ObjectSet.normalize(objectList.objectSet, object);
            if (normalizedObject) {
                const deleted = flattenedData.delete(normalizedObject.$primaryKey);
                if (deleted) {
                    dirty = true;
                }
                if (ObjectSet.contains(objectList.objectSet, normalizedObject)) {
                    const insertionIndex = flattenedData.findInsertionIndex(normalizedObject);
                    // We only can determine the correct position in this case if there's no more data to load.
                    if (insertionIndex === flattenedData.data.length && hasMore) {
                        continue;
                    }
                    flattenedData.add(normalizedObject);
                    dirty = true;
                }
            }
        }
        for (const object of observation.deletedObjects) {
            const deleted = flattenedData.delete(
                object.primaryKey as PrimaryKeyType<ObjectOrInterfaceDefinition>
            );
            if (deleted) {
                dirty = true;
            }
        }
        if (dirty) {
            query.setData({
                ...queryData,
                pages: queryData.pages.map((page, pageIndex) => ({
                    ...page,
                    data: pageIndex === 0 ? flattenedData.data : [],
                })),
            });
        }
    });
}
