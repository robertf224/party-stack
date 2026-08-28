import { User, Users } from "@osdk/foundry.admin";
import {
    applyLensToObject,
    mapTargetPathToSourceWithLens,
    type Lens,
} from "@party-stack/ontology";
import {
    FieldPath,
    LoadSubsetOptions,
    parseOrderByExpression,
    parseWhereExpression,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { Client } from "@party-stack/foundry-client";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { chunk } from "../utils/chunk.js";
import { foundryUserProfilePictureAttachment } from "./foundryUser.js";

type UsersQuery = { type: "getBatch"; ids: string[] } | { type: "search"; query: string } | { type: "list" };

function rewriteFieldPath(field: FieldPath, lens: Lens): FieldPath {
    return mapTargetPathToSourceWithLens(field.map(String), lens);
}

export interface UserCollectionOpts {
    client: Client;
    lens: Lens;
}

export function userCollectionOptions({ client, lens }: UserCollectionOpts) {
    const project = (user: User) =>
        applyLensToObject(
            {
                ...user,
                profilePicture: foundryUserProfilePictureAttachment(user.id),
            },
            lens
        );
    return queryCollectionOptions<Record<string, unknown>>({
        queryClient: new QueryClient(),
        getKey: (user) => user.id as string,
        queryKey: ["foundry", "users"],
        syncMode: "on-demand",
        queryFn: async (ctx) => {
            const loadSubsetOptions = ctx.meta?.loadSubsetOptions;

            const query = convertQuery(loadSubsetOptions, lens);

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
                return results
                    .flatMap((result) => Object.values(result.data))
                    .map(project);
            }

            const queryString = query.type === "search" ? query.query : "";
            let limit: number | undefined;
            if (query.type === "search") {
                const orderBy = parseOrderByExpression(loadSubsetOptions?.orderBy);
                if (
                    orderBy.length === 0 ||
                    (orderBy.length === 1 &&
                        orderBy[0]!.field.join(".") === "id" &&
                        orderBy[0]!.direction === "asc")
                ) {
                    limit = loadSubsetOptions?.limit;
                }
            }

            const users = await AsyncIterable.toArray(
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
            return users.map(project);
        },
    });
}

function convertQuery(options: LoadSubsetOptions | undefined, lens: Lens): UsersQuery {
    if (!options) {
        return { type: "list" };
    }

    const maybeBatchQuery =
        parseWhereExpression<UsersQuery | undefined>(options.where, {
            handlers: {
                eq: (field: FieldPath, value: unknown) => {
                    field = rewriteFieldPath(field, lens);
                    if (field.join(".") === "id") {
                        return { type: "getBatch", ids: [value as string] };
                    }
                },
                in: (field: FieldPath, value: unknown[]) => {
                    field = rewriteFieldPath(field, lens);
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
                like: (field: FieldPath, value: string) =>
                    getLikeQuery(rewriteFieldPath(field, lens), value),
                ilike: (field: FieldPath, value: string) =>
                    getLikeQuery(rewriteFieldPath(field, lens), value),
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
