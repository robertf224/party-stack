import { QueryTypes } from "@osdk/foundry.ontologies";
import { FieldPath, LoadSubsetOptions, parseWhereExpression } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { OntologyCollectionOptions, QueryTypeDef } from "@party-stack/ontology";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { convertFoundryMetaQueryType } from "./convertMetaQueryType.js";
import type { QueryTypeV2 } from "@osdk/foundry.ontologies";

export interface QueryTypeCollectionOpts {
    client: OntologyClient;
    queryClient?: QueryClient;
}

async function listQueryTypes(opts: QueryTypeCollectionOpts): Promise<QueryTypeV2[]> {
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

async function getQueryTypes(opts: QueryTypeCollectionOpts, names: string[]): Promise<QueryTypeV2[]> {
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) return [];
    return Promise.all(
        uniqueNames.map((name) => QueryTypes.get(opts.client, opts.client.ontologyRid, name))
    );
}

export function queryTypeCollectionOptions(opts: QueryTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<QueryTypeDef>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row: { name: string }) => row.name,
        queryKey: ["foundry", "ontology", "queryTypes"],
        syncMode: "on-demand",
        queryFn: async (ctx): Promise<QueryTypeDef[]> => {
            const query = convertQueryTypeQuery(ctx.meta?.loadSubsetOptions);
            const queryTypes =
                query.type === "getBatch"
                    ? await getQueryTypes(opts, query.names)
                    : await listQueryTypes(opts);
            return queryTypes.map(convertFoundryMetaQueryType);
        },
    }) as unknown as OntologyCollectionOptions;
}

type QueryTypeQuery = { type: "getBatch"; names: string[] } | { type: "list" };

function convertQueryTypeQuery(options?: LoadSubsetOptions): QueryTypeQuery {
    if (!options?.where) {
        return { type: "list" };
    }

    const batchQuery =
        parseWhereExpression<QueryTypeQuery | undefined>(options.where, {
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
