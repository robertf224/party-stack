import { GraphQLID, GraphQLInterfaceType } from "graphql";
import { Schemas } from "../utils/Schemas.js";
import { GetTypeReference } from "../utils/TypeRegistry.js";

const TYPE_NAME = "Node";

/**
 * We use _id rather than `id` because:
 * - it aligns with Foundry's internal GraphQL gateway which we should converge with over time.
 * - we will generally avoid collisions with actual property API names.
 * - Relay can actually handle this now (https://github.com/facebook/relay/issues/3897).
 */
const FIELD_NAME = "_id";

function create(): GraphQLInterfaceType {
    return new GraphQLInterfaceType({
        name: TYPE_NAME,
        description: "A record with a global id.",
        fields: {
            [FIELD_NAME]: {
                description: "The global id of the record.",
                type: Schemas.required(GraphQLID),
            },
        },
    });
}

function getReference(getTypeReference: GetTypeReference): GraphQLInterfaceType {
    return getTypeReference(TYPE_NAME) as GraphQLInterfaceType;
}

export const NodeInterface = {
    create,
    getReference,
    FIELD_NAME,
};
