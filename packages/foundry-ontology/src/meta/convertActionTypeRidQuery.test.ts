import { and, eq, inArray, IR, like } from "@tanstack/db";
import { describe, expect, it } from "vitest";
import { convertActionTypeRidQuery } from "./convertActionTypeRidQuery.js";

describe("convertActionTypeRidQuery", () => {
    it("detects eq/inArray id lookups", () => {
        expect(
            convertActionTypeRidQuery({
                where: eq(new IR.PropRef<string>(["id"]), "ri.actions.main.action-type.a"),
            })
        ).toEqual({
            type: "byRid",
            rids: ["ri.actions.main.action-type.a"],
        });

        expect(
            convertActionTypeRidQuery({
                where: inArray(new IR.PropRef<string>(["id"]), [
                    "ri.actions.main.action-type.a",
                    "ri.actions.main.action-type.b",
                ]),
            })
        ).toEqual({
            type: "byRid",
            rids: ["ri.actions.main.action-type.a", "ri.actions.main.action-type.b"],
        });
    });

    it("falls back to search for unsupported or mixed predicates", () => {
        expect(
            convertActionTypeRidQuery({
                where: like(new IR.PropRef<string>(["displayName"]), "%Create%"),
            })
        ).toEqual({ type: "search" });

        expect(
            convertActionTypeRidQuery({
                where: and(
                    eq(new IR.PropRef<string>(["id"]), "ri.actions.main.action-type.a"),
                    eq(new IR.PropRef<string>(["name"]), "createPost")
                ),
            })
        ).toEqual({ type: "search" });
    });
});
