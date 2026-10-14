import { defineOntology, o } from "@party-stack/ontology";
import {
    createFoundryOntologyRoute,
    type FoundryOntologyRoute,
} from "../installation/createFoundryBackendInstallation.js";
import { createFoundryUsersIntegration } from "./createFoundryUsersIntegration.js";
import { foundryUserObjectType } from "./foundryUser.js";

const foundryUserIdentityLens = {
    operations: [
        o.LensOp.select({
            properties: foundryUserObjectType.properties.map((property) => property.name),
        }),
    ],
};

export const foundryAdminOntology = defineOntology({
    types: [],
    objectTypes: [foundryUserObjectType],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    contextType: o.struct({
        fields: [
            {
                name: "user",
                displayName: "User",
                type: o.objectReference({
                    objectType: "FoundryUser",
                }),
            },
        ],
    }),
});

export function createFoundryAdminOntologyRoute(
    options: {
        ontologyId?: string;
    } = {}
): FoundryOntologyRoute {
    const ontologyId = options.ontologyId ?? "admin";
    return createFoundryOntologyRoute({
        ontologyId,
        ir: foundryAdminOntology,
        users: createFoundryUsersIntegration({
            objectType: "FoundryUser",
            lens: foundryUserIdentityLens,
        }),
    });
}
