import { createMetaLiveOntology } from "@party-stack/ontology";
import { eq, queryOnce } from "@tanstack/db";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFoundryMetaOntologyBackendAdapter } from "./createFoundryMetaOntologyBackendAdapter.js";
import type { OntologyClient } from "@party-stack/foundry-client";

const mocks = vi.hoisted(() => ({
    bulkLoadOntologyEntities: vi.fn(),
    getFullMetadataBatch: vi.fn(),
    searchActionTypes: vi.fn(),
}));

vi.mock("@osdk/client.unstable", () => ({ bulkLoadOntologyEntities: mocks.bulkLoadOntologyEntities }));

vi.mock("@osdk/foundry.ontologies", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.ontologies")>();
    return {
        ...original,
        ActionTypesV2: { ...original.ActionTypesV2, search: mocks.searchActionTypes },
        ActionTypesFullMetadata: {
            ...original.ActionTypesFullMetadata,
            getFullMetadataBatch: mocks.getFullMetadataBatch,
        },
    };
});

const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ri.ontology.main.ontology.example",
    tokenProvider: () => Promise.resolve("token"),
    fetch: globalThis.fetch,
};

beforeEach(() => {
    mocks.bulkLoadOntologyEntities.mockReset();
    mocks.getFullMetadataBatch.mockReset();
    mocks.searchActionTypes.mockReset();
    mocks.bulkLoadOntologyEntities.mockResolvedValue({ actionTypes: [] });
});

describe("Foundry ActionType metadata ID queries", () => {
    it("includes a function-backed action returned by ActionTypesV2.search", async () => {
        mocks.searchActionTypes.mockResolvedValue({
            data: [
                {
                    apiName: "create-task",
                    displayName: "Create task",
                    status: "ACTIVE",
                    parameters: {},
                    rid: "ri.actions.main.action-type.create-task",
                    operations: [],
                },
            ],
            nextPageToken: undefined,
        });
        const meta = await createMetaLiveOntology({
            backend: () => createFoundryMetaOntologyBackendAdapter({ client }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q
                    .from({ ActionType: meta.objects.ActionType })
                    .where(({ ActionType }) => eq(ActionType.id, "ri.actions.main.action-type.create-task"))
            );

            expect(mocks.searchActionTypes).toHaveBeenCalledWith(
                expect.anything(),
                "ri.ontology.main.ontology.example",
                expect.objectContaining({
                    where: { type: "actionTypeRid", value: "ri.actions.main.action-type.create-task" },
                }),
                { preview: true }
            );
            expect(mocks.getFullMetadataBatch).not.toHaveBeenCalled();
            expect(rows).toEqual([
                expect.objectContaining({
                    id: "ri.actions.main.action-type.create-task",
                    name: "createTask",
                }),
            ]);
        } finally {
            await meta.cleanup();
        }
    });

    it("loads declarative action metadata in batches", async () => {
        const actionType = {
            apiName: "create-task",
            displayName: "Create task",
            status: "ACTIVE",
            parameters: {},
            rid: "ri.actions.main.action-type.create-task",
            operations: [{ type: "createObject", objectTypeApiName: "Task" }],
        };
        mocks.searchActionTypes.mockResolvedValue({ data: [actionType], nextPageToken: undefined });
        mocks.getFullMetadataBatch.mockResolvedValue({ data: [{ actionType, fullLogicRules: [] }] });
        const meta = await createMetaLiveOntology({
            backend: () => createFoundryMetaOntologyBackendAdapter({ client }),
            persistObjects: false,
        });

        try {
            await queryOnce((q) => q.from({ ActionType: meta.objects.ActionType }));

            expect(mocks.getFullMetadataBatch).toHaveBeenCalledWith(
                expect.anything(),
                "ri.ontology.main.ontology.example",
                { requests: [{ actionType: "create-task" }] },
                { preview: true }
            );
        } finally {
            await meta.cleanup();
        }
    });
});
