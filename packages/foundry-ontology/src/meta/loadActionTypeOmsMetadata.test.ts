import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";

const { bulkLoadOntologyEntities } = vi.hoisted(() => ({
    bulkLoadOntologyEntities: vi.fn(),
}));

vi.mock("@osdk/client.unstable", () => ({
    bulkLoadOntologyEntities,
}));

import {
    convertOmsActionParameterStringConstraint,
    convertOmsActionParameterStringSuggestions,
} from "./convertOmsActionPrefills.js";
import { loadActionTypeOmsMetadata } from "./loadActionTypeOmsMetadata.js";

const client = {
    baseUrl: "https://example.com/foundry/",
    ontologyRid: "ri.ontology.main.ontology.example",
    tokenProvider: vi.fn().mockResolvedValue("token"),
    fetch: vi.fn(),
} as unknown as OntologyClient;

describe("loadActionTypeOmsMetadata", () => {
    beforeEach(() => {
        bulkLoadOntologyEntities.mockReset();
    });

    it("loads OMS metadata in bulk and preserves RID alignment", async () => {
        const actionType = {
            actionTypeLogic: { validation: { parameterValidations: {} } },
            metadata: {},
        };
        bulkLoadOntologyEntities.mockResolvedValue({
            actionTypes: [{ actionType }, null],
        });

        const result = await loadActionTypeOmsMetadata(client, ["ri.action.one", "ri.action.two"]);

        expect(bulkLoadOntologyEntities).toHaveBeenCalledWith(
            {
                baseUrl: "https://example.com",
                servicePath: "/ontology-metadata/api",
                tokenProvider: client.tokenProvider,
                fetchFn: client.fetch,
            },
            undefined,
            {
                actionTypes: [
                    { rid: "ri.action.one" },
                    { rid: "ri.action.two" },
                ],
                datasourceTypes: [],
                linkTypes: [],
                objectTypes: [],
                sharedPropertyTypes: [],
                interfaceTypes: [],
                typeGroups: [],
            }
        );
        expect(result.get("ri.action.one")).toBe(actionType);
        expect(result.has("ri.action.two")).toBe(false);
    });

    it("preserves the unstable bulk response action shape for conversion", async () => {
        const actionType = {
            actionTypeLogic: {
                validation: {
                    parameterValidations: {
                        country: {
                            defaultValidation: {
                                validation: {
                                    allowedValues: {
                                        type: "oneOf",
                                        oneOf: {
                                            type: "oneOf",
                                            oneOf: {
                                                labelledValues: [
                                                    {
                                                        label: "United States",
                                                        value: {
                                                            type: "string",
                                                            string: "US",
                                                        },
                                                    },
                                                    {
                                                        label: "Canada",
                                                        value: {
                                                            type: "string",
                                                            string: "CA",
                                                        },
                                                    },
                                                ],
                                                otherValueAllowed: {
                                                    allowed: true,
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            metadata: {},
        };
        bulkLoadOntologyEntities.mockResolvedValue({
            actionTypes: [
                {
                    actionType,
                    ontologyRid: "ri.ontology.main.ontology.example",
                    ontologyVersion: "1",
                    resolvedBranch: "ri.ontology.main.branch.example",
                },
            ],
            interfaceTypes: [],
            linkTypes: [],
            objectTypes: [],
            sharedPropertyTypes: [],
            typeGroups: [],
        });

        const loaded = (
            await loadActionTypeOmsMetadata(client, ["ri.action.country"])
        ).get("ri.action.country");

        expect(
            loaded?.actionTypeLogic.validation.parameterValidations
                .country?.defaultValidation.validation.allowedValues
        ).toBeDefined();
        expect(
            convertOmsActionParameterStringConstraint(
                loaded,
                "country"
            )
        ).toBeUndefined();
        expect(
            convertOmsActionParameterStringSuggestions(
                loaded,
                "country"
            )
        ).toEqual([
            {
                value: "US",
                label: "United States",
            },
            {
                value: "CA",
                label: "Canada",
            },
        ]);
    });

    it("keeps public metadata usable when the private OMS endpoint fails", async () => {
        const warn = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        bulkLoadOntologyEntities.mockRejectedValue(new Error("Unavailable"));

        await expect(
            loadActionTypeOmsMetadata(client, ["ri.action.one"])
        ).resolves.toEqual(new Map());
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    it("respects the OMS bulk-load limit", async () => {
        bulkLoadOntologyEntities.mockResolvedValue({ actionTypes: [] });
        const rids = Array.from({ length: 101 }, (_, index) => `ri.action.${index}`);

        await loadActionTypeOmsMetadata(client, rids);

        expect(bulkLoadOntologyEntities).toHaveBeenCalledTimes(2);
    });
});
