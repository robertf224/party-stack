import { User, Users } from "@osdk/foundry.admin";
import { PrincipalId } from "@osdk/foundry.core";
import { loadOneCallback } from "grafast";
import { FoundryContext } from "../context.js";

export const UserLoader = loadOneCallback<PrincipalId, User, {}, FoundryContext>(
    async (ids, { unary: context }) => {
        const users = await Users.getBatch(
            context.client,
            ids.map((id) => ({ userId: id }))
        );
        return ids.map((id) => users.data[id]);
    }
);
