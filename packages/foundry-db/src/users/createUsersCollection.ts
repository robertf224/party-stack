import { Client } from "@osdk/client";
import { User, Users } from "@osdk/foundry.admin";
import { createCollection, FieldPath, parseWhereExpression } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import * as AsyncIterable from "../AsyncIterable.js";

type UsersQuery = { type: "getBatch"; ids: string[] }; // | { type: "search"; query: string };

export interface CreateUsersCollectionOptions {
    client: Client;
}

export function createUsersCollection({ client }: CreateUsersCollectionOptions) {
    return createCollection(
        queryCollectionOptions<User, string>({
            queryClient: new QueryClient(),
            getKey: (user) => user.id,
            queryKey: ["foundry", "users"],
            queryFn: async (ctx) => {
                const loadSubsetOptions = ctx.meta?.loadSubsetOptions;

                let query: UsersQuery | undefined;
                if (loadSubsetOptions) {
                    query =
                        parseWhereExpression<UsersQuery | undefined>(loadSubsetOptions.where, {
                            handlers: {
                                // TODO: handle search and compound queries
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                in: (field: FieldPath, values: any[]) => {
                                    if (field.join(".") === "id") {
                                        return { type: "getBatch", ids: values as string[] };
                                    }
                                },
                            },
                            onUnknownOperator: () => undefined,
                        }) ?? undefined;
                }

                if (query?.type === "getBatch") {
                    // TODO: gracefully handle max batch size of 500
                    const response = await Users.getBatch(
                        client,
                        query.ids.map((userId) => ({ userId }))
                    );
                    return Object.values(response.data);
                }

                return AsyncIterable.toArray(
                    AsyncIterable.fromPagination(
                        (pageToken: string | undefined) => Users.list(client, { pageToken }),
                        (page) => page.nextPageToken,
                        (page) => page.data
                    )
                );
            },
        })
    );
}
