import { User } from "@osdk/foundry.admin";
import {
    inhibitOnNull,
    LoadedRecordStep,
    loadOne,
    nodeIdFromNode,
    NodeIdHandler,
    objectSpec,
    ObjectTypeFields,
} from "grafast";
import { GraphQLID, GraphQLObjectType, GraphQLString } from "graphql";
import { context } from "../context.js";
import { NodeHandlers } from "../nodes/NodeHandlers.js";
import { NodeInterface } from "../nodes/NodeInterface.js";
import { Schemas } from "../utils/Schemas.js";
import { GetTypeReference, TypeRegistry } from "../utils/TypeRegistry.js";
import { UserLoader } from "./UserLoader.js";
import { UserProfilePictureLoader } from "./UserProfilePictureLoader.js";

const TYPE_NAME = "User";

const NODE_ID_HANDLER: NodeIdHandler = NodeHandlers.createBasicHandler(TYPE_NAME, "id", UserLoader);

function create(typeRegistry: TypeRegistry): GraphQLObjectType {
    return new GraphQLObjectType(
        objectSpec<LoadedRecordStep<User>, ObjectTypeFields<LoadedRecordStep<User>>>({
            name: TYPE_NAME,
            description: "A Foundry user or service account.",
            fields: {
                _id: {
                    type: Schemas.required(GraphQLID),
                    plan: ($object) => {
                        return nodeIdFromNode(NODE_ID_HANDLER, $object);
                    },
                },
                id: {
                    description: "The unique identifier for the User.",
                    type: Schemas.required(GraphQLString),
                },
                username: {
                    description: "The unique username for the User.",
                    type: Schemas.required(GraphQLString),
                },
                givenName: {
                    description: "The given name of the User.",
                    type: GraphQLString,
                },
                familyName: {
                    description: "The family name (last name) of the User.",
                    type: GraphQLString,
                },
                email: {
                    description:
                        "The email at which to contact a User. Multiple Users may have the same email address.",
                    type: GraphQLString,
                },
                profilePictureUrl: {
                    description: "The URL of the User's profile picture.",
                    type: GraphQLString,
                    plan: ($user) => {
                        return loadOne(inhibitOnNull($user.get("id")), context(), UserProfilePictureLoader);
                    },
                },
            },
            interfaces: typeRegistry.use((getTypeReference) => [
                NodeInterface.getReference(getTypeReference),
            ]),
        })
    );
}

function getReference(getTypeReference: GetTypeReference): GraphQLObjectType {
    return getTypeReference(TYPE_NAME) as GraphQLObjectType;
}

export const UserType = {
    create,
    getReference,
    NODE_ID_HANDLER,
};
