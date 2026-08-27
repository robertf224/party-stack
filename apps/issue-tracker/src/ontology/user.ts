import { o, type Lens } from "@party-stack/ontology";

export const foundryUserToUser = {
    operations: [
        o.LensOp.move({
            from: ["profilePicture"],
            to: ["avatar"],
        }),
        o.LensOp.select({
            properties: ["id", "givenName", "familyName", "email", "avatar"],
        }),
    ],
} satisfies Lens;
