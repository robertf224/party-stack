import { User, Users } from "@osdk/foundry.admin";
import {
    createCollection,
    FieldPath,
    LoadSubsetOptions,
    parseOrderByExpression,
    parseWhereExpression,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { chunk } from "../utils/chunk.js";
import { Client } from "../utils/client.js";

type UsersQuery = { type: "getBatch"; ids: string[] } | { type: "search"; query: string } | { type: "list" };

export interface CreateUsersCollectionOpts {
    client: Client;
}

export function createUsersCollection({ client }: CreateUsersCollectionOpts) {
    return createCollection(
        queryCollectionOptions<User>({
            queryClient: new QueryClient(),
            getKey: (user) => user.id,
            queryKey: ["foundry", "users"],
            syncMode: "on-demand",
            queryFn: async (ctx) => {
                const loadSubsetOptions = ctx.meta?.loadSubsetOptions;

                const query = convertQuery(loadSubsetOptions);

                if (query.type === "getBatch") {
                    // The max batch size here is 500 (https://www.palantir.com/docs/foundry/api/v2/admin-v2-resources/users/get-users-batch)
                    const chunks = chunk(query.ids, 500);
                    const results = await Promise.all(
                        chunks.map((chunk) =>
                            Users.getBatch(
                                client,
                                chunk.map((userId) => ({ userId }))
                            )
                        )
                    );
                    return results.flatMap((result) => Object.values(result.data));
                }

                const queryString = query.type === "search" ? query.query : "";
                let limit: number | undefined;
                if (query.type === "search") {
                    const orderBy = parseOrderByExpression(loadSubsetOptions?.orderBy);
                    // Only if there is no order by or order by matches the default for the underlying endpoint can we push down the limit
                    // to the endpoint, otherwise we need to load everything for our query to make sure we don't miss any results.
                    if (
                        orderBy.length === 0 ||
                        (orderBy.length === 1 &&
                            orderBy[0]!.field.join(".") === "id" &&
                            orderBy[0]!.direction === "asc")
                    ) {
                        limit = loadSubsetOptions?.limit;
                    }
                }

                return AsyncIterable.toArray(
                    AsyncIterable.fromPagination(
                        (pageSize, pageToken: string | undefined) =>
                            Users.search(client, {
                                pageSize,
                                pageToken,
                                where: { type: "queryString", value: queryString },
                            }),
                        (page) => page.nextPageToken,
                        (page) => page.data,
                        10_000,
                        limit
                    )
                );
            },
        })
    );
}

function convertQuery(options?: LoadSubsetOptions): UsersQuery {
    if (!options) {
        return { type: "list" };
    }

    const maybeBatchQuery =
        parseWhereExpression<UsersQuery | undefined>(options.where, {
            handlers: {
                eq: (field: FieldPath, value: unknown) => {
                    if (field.join(".") === "id") {
                        return { type: "getBatch", ids: [value as string] };
                    }
                },
                in: (field: FieldPath, value: unknown[]) => {
                    if (field.join(".") === "id") {
                        return {
                            type: "getBatch",
                            ids: value.filter((v) => v !== null && v !== undefined) as string[],
                        };
                    }
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;
    if (maybeBatchQuery) {
        return maybeBatchQuery;
    }

    const maybeSearchQuery =
        parseWhereExpression<UsersQuery | undefined>(options.where, {
            handlers: {
                like: (field: FieldPath, value: string) => getLikeQuery(field, value),
                ilike: (field: FieldPath, value: string) => getLikeQuery(field, value),
                onUnknownOperator: () => undefined,
            },
        }) ?? undefined;
    if (maybeSearchQuery) {
        return maybeSearchQuery;
    }

    return { type: "list" };
}

function getLikeQuery(field: FieldPath, value: string) {
    return (
        getLikeQueryForTargetField(field, value, "username") ??
        getLikeQueryForTargetField(field, value, "givenName") ??
        getLikeQueryForTargetField(field, value, "familyName")
    );
}

function getLikeQueryForTargetField(
    field: FieldPath,
    value: string,
    targetField: string
): UsersQuery | undefined {
    if (
        field.join(".") === targetField &&
        value.endsWith("%") &&
        !value.startsWith("%") &&
        !value.includes("_")
    ) {
        return { type: "search", query: value.replace("%", "") };
    }
}
