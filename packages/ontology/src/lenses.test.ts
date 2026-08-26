import { describe, expect, it } from "vitest";
import { o } from "./ir/index.js";
import { applyLensToObject, applyLensToObjectType, mapTargetPathToSourceWithLens } from "./lenses.js";
import type { Lens, ObjectTypeDef } from "./ir/index.js";

const source: ObjectTypeDef = {
    name: "FoundryUser",
    displayName: "Foundry user",
    pluralDisplayName: "Foundry users",
    primaryKey: "id",
    properties: [
        { name: "id", displayName: "ID", type: o.string({}) },
        { name: "givenName", displayName: "Given name", type: o.optional({ type: o.string({}) }) },
        { name: "familyName", displayName: "Family name", type: o.optional({ type: o.string({}) }) },
        { name: "email", displayName: "Email", type: o.optional({ type: o.string({}) }) },
        { name: "profilePicture", displayName: "Profile picture", type: o.optional({ type: o.attachment({}) }) },
        { name: "admin", displayName: "Admin", type: o.boolean({}) },
    ],
};

const lens: Lens = {
    operations: [
        o.LensOp.move({
            from: ["profilePicture"],
            to: ["avatar"],
        }),
        o.LensOp.select({
            properties: ["id", "givenName", "familyName", "email", "avatar"],
        }),
    ],
};

describe("ontology lenses", () => {
    it("derives an object type through move and select", () => {
        expect(applyLensToObjectType(source, lens, { name: "User" })).toEqual({
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "givenName", displayName: "Given name", type: o.optional({ type: o.string({}) }) },
                { name: "familyName", displayName: "Family name", type: o.optional({ type: o.string({}) }) },
                { name: "email", displayName: "Email", type: o.optional({ type: o.string({}) }) },
                { name: "avatar", displayName: "Avatar", type: o.optional({ type: o.attachment({}) }) },
            ],
        });
    });

    it("projects values and rewrites target paths", () => {
        expect(
            applyLensToObject(
                {
                    id: "user-1",
                    givenName: "Ada",
                    familyName: "Lovelace",
                    profilePicture: { id: "picture-1" },
                    admin: true,
                },
                lens
            )
        ).toEqual({
            id: "user-1",
            givenName: "Ada",
            familyName: "Lovelace",
            avatar: { id: "picture-1" },
        });
        expect(mapTargetPathToSourceWithLens(["avatar", "id"], lens)).toEqual(["profilePicture", "id"]);
        expect(mapTargetPathToSourceWithLens(["familyName"], lens)).toEqual(["familyName"]);
    });
});
