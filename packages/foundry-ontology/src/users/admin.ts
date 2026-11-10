import { defineOntology, o } from "@party-stack/ontology-spec";
import { makeFoundryBackend } from "../backend.js";
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
    context: {
        type: o.struct({
            fields: [
                {
                    name: "userId",
                    displayName: "User ID",
                    type: o.objectReference({
                        objectType: "FoundryUser",
                    }),
                },
            ],
        }),
        partition: [["userId"]],
    },
});

export function makeFoundryAdminBackend(
    options: Omit<Parameters<typeof makeFoundryBackend>[0], "ir" | "users">
) {
    return makeFoundryBackend({
        ...options,
        ir: foundryAdminOntology,
        users: createFoundryUsersIntegration({ objectType: "FoundryUser", lens: foundryUserIdentityLens }),
    });
}
