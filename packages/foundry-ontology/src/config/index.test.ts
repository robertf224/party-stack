import { o, type OntologyIR } from "@party-stack/ontology";
import { describe, expect, it } from "vitest";
import { foundryOntologyConfigAdapter } from "./index.js";

describe("foundryOntologyConfigAdapter", () => {
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

        const transformed = await foundryOntologyConfigAdapter.transformOntology!(ir, {
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
});
