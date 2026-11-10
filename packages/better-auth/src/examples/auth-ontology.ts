import { o, type OntologyIR, type TypeDef } from "@party-stack/ontology-spec";
import type { AuthModelView } from "../storage/index.js";

const text = o.string({});
const timestamp = o.timestamp({});
const optional = (type: TypeDef) => o.optional({ type });
const timestamps = { createdAt: timestamp, updatedAt: timestamp };
const userId = o.objectReference({ objectType: "AuthUser" });
const object = (name: string, fields: Record<string, TypeDef>) => ({
    name,
    displayName: name,
    pluralDisplayName: name,
    primaryKey: "id",
    properties: Object.entries({ id: text, ...fields }).map(([name, type]) => ({
        name,
        displayName: name,
        type,
    })),
});

export const authOntology: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        object("AuthUser", {
            name: text,
            email: text,
            emailVerified: o.boolean({}),
            image: optional(text),
            ...timestamps,
        }),
        object("AuthSession", {
            userId,
            token: text,
            expiresAt: timestamp,
            ipAddress: optional(text),
            userAgent: optional(text),
            ...timestamps,
        }),
        object("AuthAccount", {
            userId,
            issuer: text,
            accountId: text,
            providerId: text,
            accessToken: optional(text),
            refreshToken: optional(text),
            idToken: optional(text),
            accessTokenExpiresAt: optional(timestamp),
            refreshTokenExpiresAt: optional(timestamp),
            scope: optional(text),
            password: optional(text),
            ...timestamps,
        }),
        object("AuthVerification", {
            identifier: text,
            value: text,
            expiresAt: timestamp,
            ...timestamps,
        }),
    ],
};

export const authModels: Record<string, AuthModelView> = {
    user: { objectType: "AuthUser", lens: { operations: [] } },
    session: { objectType: "AuthSession", lens: { operations: [] } },
    account: { objectType: "AuthAccount", lens: { operations: [] } },
    verification: { objectType: "AuthVerification", lens: { operations: [] } },
};
