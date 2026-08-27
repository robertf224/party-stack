import { o, type OntologyIR } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import { foundryOntologyPullSource } from "./index.js";

describe("foundryOntologyPullSource", () => {
    it("applies targeted attachment constraints after pull", async () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "id",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        {
                            name: "media",
                            displayName: "Media",
                            type: o.attachment({
                                meta: { type: "media" },
                            }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createTask",
                    displayName: "Create Task",
                    parameters: [
                        {
                            name: "media",
                            displayName: "Media",
                            type: o.optional({
                                type: o.attachment({
                                    meta: { type: "media" },
                                }),
                            }),
                        },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        };
        const constraint = {
            content: o.AttachmentContentConstraint.image({
                mediaTypes: ["image/png", "image/jpeg"],
            }),
        };

        const transformed = await foundryOntologyPullSource.transformPulledOntology!(ir, {
            attachmentConstraints: [
                {
                    target: {
                        kind: "objectProperty",
                        objectType: "Task",
                        property: "media",
                    },
                    constraint,
                },
                {
                    target: {
                        kind: "actionParameter",
                        actionType: "createTask",
                        parameter: "media",
                    },
                    constraint,
                },
            ],
        });

        expect(transformed.objectTypes[0]?.properties[1]?.type).toEqual(
            o.attachment({
                constraint,
                meta: { type: "media" },
            })
        );
        expect(transformed.actionTypes[0]?.parameters[0]?.type).toEqual(
            o.optional({
                type: o.attachment({
                    constraint,
                    meta: { type: "media" },
                }),
            })
        );
    });

    it("adds the configured User type and context", async () => {
        const ir: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "id",
                    properties: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        {
                            name: "createdBy",
                            displayName: "Created by",
                            type: o.objectReference({ objectType: "User" }),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createTask",
                    displayName: "Create task",
                    parameters: [],
                    logic: [
                        o.ActionLogicStep.createObject({
                            objectType: "Task",
                            values: [
                                {
                                    property: ["createdBy"],
                                    value: o.Expression.contextReference({
                                        path: ["user"],
                                    }),
                                },
                            ],
                        }),
                    ],
                },
            ],
            queryFunctionTypes: [],
        };

        const transformed = await foundryOntologyPullSource.transformPulledOntology!(
            ir,
            {
                users: {
                    objectType: "User",
                    lens: {
                        operations: [
                            o.LensOp.move({
                                from: ["profilePicture"],
                                to: ["avatar"],
                            }),
                            o.LensOp.select({
                                properties: ["id", "avatar"],
                            }),
                        ],
                    },
                },
            }
        );

        expect(transformed.objectTypes.map((type) => type.name)).toContain(
            "User"
        );
        expect(transformed.contextType).toEqual(
            o.struct({
                fields: [
                    {
                        name: "user",
                        displayName: "User",
                        type: o.objectReference({ objectType: "User" }),
                    },
                ],
            })
        );
        expect(
            transformed.actionTypes[0]?.logic[0]?.kind === "createObject"
                ? transformed.actionTypes[0].logic[0].value.values[0]?.value
                : undefined
        ).toEqual(o.Expression.contextReference({ path: ["user"] }));
    });
});
