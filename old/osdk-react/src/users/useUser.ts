"use client";

import { Client } from "@osdk/client";
import { User, Users } from "@osdk/foundry.admin";
import { useSuspenseQuery, UseSuspenseQueryResult } from "@tanstack/react-query";
import { Batcher, create, indexedResolver, windowScheduler } from "@yornaath/batshit";
import { useOsdkContext } from "../OsdkContext";

type UserLoader = Batcher<Record<string, User>, string, User | null>;
const cache = new WeakMap<Client, UserLoader>();
function getUsersLoader(client: Client): UserLoader {
    if (cache.has(client)) {
        return cache.get(client) as UserLoader;
    }
    const usersLoader = create({
        fetcher: async (userIds: string[]) => {
            const result = await Users.getBatch(
                client,
                userIds.map((userId) => ({ userId }))
            );
            return result.data;
        },
        resolver: indexedResolver(),
        // https://www.palantir.com/docs/foundry/api/v2/admin-v2-resources/users/get-users-batch#get-users-batch
        scheduler: windowScheduler(500),
    });
    cache.set(client, usersLoader);
    return usersLoader;
}

export function useUser(userId: string): UseSuspenseQueryResult<User | null> {
    const { client } = useOsdkContext();
    return useSuspenseQuery({
        queryFn: async () => {
            const usersLoader = getUsersLoader(client);
            const user = await usersLoader.fetch(userId);
            return user;
        },
        queryKey: ["osdk", "user", userId],
    });
}
