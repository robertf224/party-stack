import { and, eq, ilike, inArray, IR, like, or } from "@tanstack/db";
import { describe, expect, it } from "vitest";
import {
    convertActionTypeLoadSubsetFilter,
    convertActionTypeLoadSubsetOrderBy,
} from "./convertActionTypeLoadSubsetOptions.js";

describe("convertActionTypeLoadSubsetFilter", () => {
    it("converts name equality to an exact apiName predicate with kebab-case", () => {
        const filter = convertActionTypeLoadSubsetFilter(
            eq(new IR.PropRef<string>(["name"]), "streamlineCreateToken")
        );

        expect(filter).toEqual({
            type: "actionTypeApiName",
            value: { type: "exact", value: "streamline-create-token" },
        });
    });

    it("converts name inArray to an or of exact apiName predicates", () => {
        const filter = convertActionTypeLoadSubsetFilter(
            inArray(new IR.PropRef<string>(["name"]), ["createTask", "completeTask"])
        );

        expect(filter).toEqual({
            type: "or",
            value: [
                {
                    type: "actionTypeApiName",
                    value: { type: "exact", value: "create-task" },
                },
                {
                    type: "actionTypeApiName",
                    value: { type: "exact", value: "complete-task" },
                },
            ],
        });
    });

    it("converts displayName like/ilike to contains predicates", () => {
        expect(
            convertActionTypeLoadSubsetFilter(like(new IR.PropRef<string>(["displayName"]), "%Token%"))
        ).toEqual({
            type: "actionTypeDisplayName",
            value: { type: "contains", value: "Token" },
        });

        expect(
            convertActionTypeLoadSubsetFilter(ilike(new IR.PropRef<string>(["displayName"]), "%token%"))
        ).toEqual({
            type: "actionTypeDisplayName",
            value: { type: "contains", value: "token" },
        });
    });

    it("converts each like wildcard-delimited term to a contains predicate", () => {
        expect(
            convertActionTypeLoadSubsetFilter(
                like(new IR.PropRef<string>(["name"]), "%streamline%Create%Token%")
            )
        ).toEqual({
            type: "and",
            value: [
                {
                    type: "actionTypeApiName",
                    value: { type: "contains", value: "streamline" },
                },
                {
                    type: "actionTypeApiName",
                    value: { type: "contains", value: "create" },
                },
                {
                    type: "actionTypeApiName",
                    value: { type: "contains", value: "token" },
                },
            ],
        });
    });

    it("supports and/or composition", () => {
        const filter = convertActionTypeLoadSubsetFilter(
            and(
                or(
                    eq(new IR.PropRef<string>(["name"]), "createTask"),
                    eq(new IR.PropRef<string>(["name"]), "deleteTask")
                ),
                like(new IR.PropRef<string>(["displayName"]), "%Task%")
            )
        );

        expect(filter).toEqual({
            type: "and",
            value: [
                {
                    type: "or",
                    value: [
                        {
                            type: "actionTypeApiName",
                            value: { type: "exact", value: "create-task" },
                        },
                        {
                            type: "actionTypeApiName",
                            value: { type: "exact", value: "delete-task" },
                        },
                    ],
                },
                {
                    type: "actionTypeDisplayName",
                    value: { type: "contains", value: "Task" },
                },
            ],
        });
    });

    it("converts empty inArray to an empty or query", () => {
        const filter = convertActionTypeLoadSubsetFilter(inArray(new IR.PropRef<string>(["name"]), []));
        expect(filter).toEqual({ type: "or", value: [] });
    });

    it("rejects unsupported fields", () => {
        expect(() =>
            convertActionTypeLoadSubsetFilter(eq(new IR.PropRef<string>(["rid"]), "some-rid"))
        ).toThrow(/does not support filtering/);
    });

    it("converts displayName ordering", () => {
        expect(
            convertActionTypeLoadSubsetOrderBy([
                {
                    expression: new IR.PropRef(["displayName"]),
                    compareOptions: { direction: "desc", nulls: "last" },
                },
            ])
        ).toEqual({
            field: "actionTypeDisplayName",
            direction: "desc",
        });
    });

    it("does not push down unsupported or multiple order fields", () => {
        expect(
            convertActionTypeLoadSubsetOrderBy([
                {
                    expression: new IR.PropRef(["name"]),
                    compareOptions: { direction: "asc", nulls: "last" },
                },
            ])
        ).toBeUndefined();

        expect(
            convertActionTypeLoadSubsetOrderBy([
                {
                    expression: new IR.PropRef(["displayName"]),
                    compareOptions: { direction: "asc", nulls: "last" },
                },
                {
                    expression: new IR.PropRef(["name"]),
                    compareOptions: { direction: "asc", nulls: "last" },
                },
            ])
        ).toBeUndefined();
    });
});
