import { QueryTypes } from "@osdk/foundry.ontologies";
import { FieldPath, LoadSubsetOptions, parseWhereExpression } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyCollectionOptions, QueryFunctionTypeDef } from "@party-stack/ontology";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { convertFoundryMetaQueryFunctionType } from "./convertMetaQueryFunctionType.js";
import type { QueryTypeV2 } from "@osdk/foundry.ontologies";

export interface QueryFunctionTypeCollectionOpts {
    client: OntologyClient;
    queryClient?: QueryClient;
}

async function listQueryFunctionTypes(opts: QueryFunctionTypeCollectionOpts): Promise<QueryTypeV2[]> {
    return AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                QueryTypes.list(opts.client, opts.client.ontologyRid, {
                    pageSize,
                    pageToken,
                }),
            (page) => page.nextPageToken,
            (page) => page.data,
            100
        )
    );
}

async function getQueryFunctionTypes(opts: QueryFunctionTypeCollectionOpts, names: string[]): Promise<QueryTypeV2[]> {
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) return [];
    return Promise.all(
        uniqueNames.map((name) => QueryTypes.get(opts.client, opts.client.ontologyRid, name))
    );
}

export function queryFunctionTypeCollectionOptions(opts: QueryFunctionTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<QueryFunctionTypeDef>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row: { name: string }) => row.name,
        queryKey: ["foundry", "ontology", "queryFunctionTypes"],
        syncMode: "on-demand",
        queryFn: async (ctx): Promise<QueryFunctionTypeDef[]> => {
            const query = convertQueryFunctionTypeQuery(ctx.meta?.loadSubsetOptions);
            const queryFunctionTypes =
                query.type === "getBatch"
                    ? await getQueryFunctionTypes(opts, query.names)
                    : await listQueryFunctionTypes(opts);
            return queryFunctionTypes.map(convertFoundryMetaQueryFunctionType);
        },
    }) as unknown as OntologyCollectionOptions;
}

type QueryFunctionTypeQuery = { type: "getBatch"; names: string[] } | { type: "list" };

function convertQueryFunctionTypeQuery(options?: LoadSubsetOptions): QueryFunctionTypeQuery {
    if (!options?.where) {
        return { type: "list" };
    }

    const batchQuery =
        parseWhereExpression<QueryFunctionTypeQuery | undefined>(options.where, {
            handlers: {
                eq: (field: FieldPath, value: unknown) => {
                    if (field.join(".") === "name") {
                        return { type: "getBatch", names: [String(value)] };
                    }
                },
                in: (field: FieldPath, value: unknown[]) => {
                    if (field.join(".") === "name") {
                        return {
                            type: "getBatch",
                            names: value
                                .filter((candidate) => candidate !== null && candidate !== undefined)
                                .map(String),
                        };
                    }
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;

    return batchQuery ?? { type: "list" };
}
