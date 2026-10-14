import { ActionTypeV2 } from "@osdk/foundry.ontologies";
import { LoadedRecordStep, nodeIdFromNode, NodeIdHandler, objectSpec, ObjectTypeFields } from "grafast";
import { GraphQLID, GraphQLObjectType, GraphQLString } from "graphql";
import { NodeHandlers } from "../nodes/NodeHandlers.js";
import { NodeInterface } from "../nodes/NodeInterface.js";
import { Schemas } from "../utils/Schemas.js";
import { GetTypeReference, TypeRegistry } from "../utils/TypeRegistry.js";
import { ActionTypeLoader } from "./ActionTypeLoader.js";

const TYPE_NAME = "ActionType";

const NODE_ID_HANDLER: NodeIdHandler = NodeHandlers.createBasicHandler(TYPE_NAME, "rid", ActionTypeLoader);

function create(typeRegistry: TypeRegistry): GraphQLObjectType {
    return new GraphQLObjectType(
        objectSpec<LoadedRecordStep<ActionTypeV2>, ObjectTypeFields<LoadedRecordStep<ActionTypeV2>>>({
            name: TYPE_NAME,
            description: "A Foundry Action type.",
            fields: {
                _id: {
                    type: Schemas.required(GraphQLID),
                    plan: ($object) => {
                        return nodeIdFromNode(NODE_ID_HANDLER, $object);
                    },
                },
                rid: {
                    description: "The unique identifier for the Action type.",
                    type: Schemas.required(GraphQLString),
                },
                apiName: {
                    description: "The unique API name for the Action type.",
                    type: Schemas.required(GraphQLString),
                },
                displayName: {
                    description: "The display name of the Action type.",
                    type: Schemas.required(GraphQLString),
                },
                description: {
                    description: "The description of the Action type.",
                    type: GraphQLString,
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
