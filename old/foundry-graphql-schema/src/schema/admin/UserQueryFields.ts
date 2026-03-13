import { User } from "@osdk/foundry.admin";
import { inhibitOnNull, loadOne, objectFieldSpec, Step } from "grafast";
import { GraphQLString } from "graphql";
import { context } from "../context.js";
import { NamedGraphQLFieldConfig } from "../utils/NamedGraphQLFieldConfig.js";
import { Schemas } from "../utils/Schemas.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";
import { UserLoader } from "./UserLoader.js";
import { UserType } from "./UserType.js";

function create(getTypeReference: GetTypeReference): NamedGraphQLFieldConfig[] {
    const viewer: NamedGraphQLFieldConfig = [
        "viewer",
        objectFieldSpec<Step, Step<User>>(
            {
                description: "The current User.",
                type: UserType.getReference(getTypeReference),
                plan: () => {
                    return loadOne(inhibitOnNull(context().get("userId")), context(), UserLoader);
                },
            },
            "Query.viewer"
        ),
    ];

    const user: NamedGraphQLFieldConfig = [
        "user",
        objectFieldSpec<Step, Step<User>>(
            {
                description: "Get a single User.",
                args: {
                    id: {
                        type: Schemas.required(GraphQLString),
                    },
                },
                type: UserType.getReference(getTypeReference),
                plan: (_$parent, $args) => {
                    return loadOne($args.getRaw("id"), context(), UserLoader);
                },
            },
            "Query.user"
        ),
    ];

    return [viewer, user];
}

export const UserQueryFields = {
    create,
};
