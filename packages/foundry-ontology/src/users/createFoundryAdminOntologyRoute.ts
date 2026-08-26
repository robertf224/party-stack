import { defineOntology, o, type OntologyRoute } from "@party-stack/ontology";
import { createFoundryOntologyRoute } from "../installation/createFoundryBackendInstallation.js";
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

export function createFoundryAdminOntologyRoute(options: {
    baseUrl: string;
    ontologyId?: string;
}): OntologyRoute {
    const ontologyId = options.ontologyId ?? "admin";
    return createFoundryOntologyRoute({
        ontologyId,
        baseUrl: options.baseUrl,
        ir: foundryAdminOntology,
        users: () =>
            createFoundryUsersIntegration({
                objectType: "FoundryUser",
                lens: foundryUserIdentityLens,
            }),
        persistObjects: true,
    });
}
