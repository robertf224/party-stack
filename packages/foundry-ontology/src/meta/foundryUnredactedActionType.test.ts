import { describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import { getFoundryUnredactedActionTypeMetadata } from "./foundryUnredactedActionType.js";

describe("getFoundryUnredactedActionTypeMetadata", () => {
    it("posts to OMS bulkLoadEntities and maps parameter validations", async () => {
        const fetch = vi.fn(() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        actionTypes: [
                            {
                                actionType: {
                                    rid: "ri.actions.main.action-type.example",
                                    metadata: {
                                        rid: "ri.actions.main.action-type.example",
                                        apiName: "modify-task",
                                    },
                                    actionTypeLogic: {
                                        validation: {
                                            parameterValidations: {
                                                title: {
                                                    defaultValidation: {
                                                        prefill: {
                                                            type: "staticValue",
                                                            staticValue: {
                                                                type: "string",
                                                                string: "Untitled",
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                        logic: { rules: [] },
                                    },
                                },
                            },
                        ],
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            )
        );

        const client: OntologyClient = {
            baseUrl: "https://foundry.example.com",
            ontologyRid: "ri.ontology.main.ontology.example",
            tokenProvider: () => Promise.resolve("token"),
            fetch: fetch as unknown as typeof globalThis.fetch,
        };

        const result = await getFoundryUnredactedActionTypeMetadata(
            client,
            "ri.actions.main.action-type.example"
        );

        expect(fetch).toHaveBeenCalledWith(
            expect.objectContaining({
                href: "https://foundry.example.com/ontology-metadata/api/ontology/ontology/bulkLoadEntities",
            }),
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    Authorization: "Bearer token",
                }) as Record<string, string>,
            })
        );
        expect(result).toEqual({
            rid: "ri.actions.main.action-type.example",
            apiName: "modify-task",
            parameterValidations: {
                title: {
                    defaultValidation: {
                        prefill: {
                            type: "staticValue",
                            staticValue: { type: "string", string: "Untitled" },
                        },
                    },
                },
            },
            actionTypeLogic: {
                validation: {
                    parameterValidations: {
                        title: {
                            defaultValidation: {
                                prefill: {
                                    type: "staticValue",
                                    staticValue: { type: "string", string: "Untitled" },
                                },
                            },
                        },
                    },
                },
                logic: { rules: [] },
            },
            metadata: {
                rid: "ri.actions.main.action-type.example",
                apiName: "modify-task",
            },
        });
    });

    it("returns undefined when OMS has no matching action type", async () => {
        const client: OntologyClient = {
            baseUrl: "https://foundry.example.com",
            ontologyRid: "ri.ontology.main.ontology.example",
            tokenProvider: () => Promise.resolve("token"),
            fetch: (() =>
                Promise.resolve(
                    new Response(JSON.stringify({ actionTypes: [] }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    })
                )) as typeof globalThis.fetch,
        };

        await expect(
            getFoundryUnredactedActionTypeMetadata(client, "ri.actions.main.action-type.missing")
        ).resolves.toBeUndefined();
    });
});
