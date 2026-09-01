import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";

const { bulkLoadOntologyEntities } = vi.hoisted(() => ({
    bulkLoadOntologyEntities: vi.fn(),
}));

vi.mock("@bobbyfidz/oms", () => ({
    ontologyMetadataApi: {
        OntologyMetadataService: class {
            bulkLoadOntologyEntities = bulkLoadOntologyEntities;
        },
    },
}));

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

        expect(bulkLoadOntologyEntities).toHaveBeenCalledWith({
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
        });
        expect(result.get("ri.action.one")).toBe(actionType);
        expect(result.has("ri.action.two")).toBe(false);
    });

    it("keeps public metadata usable when the private OMS endpoint fails", async () => {
        bulkLoadOntologyEntities.mockRejectedValue(new Error("Unavailable"));

        await expect(
            loadActionTypeOmsMetadata(client, ["ri.action.one"])
        ).resolves.toEqual(new Map());
    });

    it("respects the OMS bulk-load limit", async () => {
        bulkLoadOntologyEntities.mockResolvedValue({ actionTypes: [] });
        const rids = Array.from({ length: 101 }, (_, index) => `ri.action.${index}`);

        await loadActionTypeOmsMetadata(client, rids);

        expect(bulkLoadOntologyEntities).toHaveBeenCalledTimes(2);
    });
});
