import { o, type OntologyIR, type TypeDef } from "@party-stack/ontology";
import ontology from "../ontology/ontology";
import type { AuthModelView } from "@party-stack/better-auth/storage";

const string = o.string({});
const instant = o.timestamp({});
const optional = (type: TypeDef) => o.optional({ type });
const person = o.objectReference({ objectType: "User" });
const object = (name: string, fields: Record<string, TypeDef>, primaryKey = "id") => ({
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    primaryKey,
    properties: Object.entries(fields).map(([name, type]) => ({ name, displayName: name, type })),
});

// The server owns the complete schema. The remote server exposes only the
// issue-tracker ontology view, excluding private auth types and properties.
export const serverOntology: OntologyIR = {
    ...ontology,
    objectTypes: [
        ...ontology.objectTypes.filter((object) => object.name !== "User"),
        {
            ...ontology.objectTypes.find((object) => object.name === "User")!,
            properties: [
                ...ontology.objectTypes.find((object) => object.name === "User")!.properties,
                ...Object.entries({
                    displayName: string,
                    emailVerified: o.boolean({}),
                    avatarUrl: optional(string),
                    createdAt: instant,
                    updatedAt: instant,
                }).map(([name, type]) => ({ name, displayName: name, type })),
            ],
        },
        object("Session", {
            id: string,
            person,
            token: string,
            expiresAt: instant,
            createdAt: instant,
            updatedAt: instant,
            ipAddress: optional(string),
            userAgent: optional(string),
        }),
        object("LoginMethod", {
            id: string,
            person,
            issuer: string,
            accountId: string,
            providerId: string,
            accessToken: optional(string),
            refreshToken: optional(string),
            idToken: optional(string),
            accessTokenExpiresAt: optional(instant),
            refreshTokenExpiresAt: optional(instant),
            scope: optional(string),
            passwordHash: optional(string),
            createdAt: instant,
            updatedAt: instant,
        }),
        object("Verification", {
            id: string,
            identifier: string,
            value: string,
            expiresAt: instant,
            createdAt: instant,
            updatedAt: instant,
        }),
    ],
};
export const authModels: Record<string, AuthModelView> = {
    user: {
        objectType: "User",
        lens: {
            operations: [
                o.LensOp.move({ from: ["displayName"], to: ["name"] }),
                o.LensOp.move({ from: ["avatarUrl"], to: ["image"] }),
                o.LensOp.select({
                    properties: [
                        "id",
                        "name",
                        "email",
                        "emailVerified",
                        "image",
                        "givenName",
                        "familyName",
                        "createdAt",
                        "updatedAt",
                    ],
                }),
            ],
        },
    },
    session: {
        objectType: "Session",
        lens: { operations: [o.LensOp.move({ from: ["person"], to: ["userId"] })] },
    },
    account: {
        objectType: "LoginMethod",
        lens: {
            operations: [
                o.LensOp.move({ from: ["person"], to: ["userId"] }),
                o.LensOp.move({ from: ["passwordHash"], to: ["password"] }),
            ],
        },
    },
    verification: { objectType: "Verification", lens: { operations: [] } },
};
