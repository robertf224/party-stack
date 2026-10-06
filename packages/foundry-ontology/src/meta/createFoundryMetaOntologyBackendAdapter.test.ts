import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import { createFoundryMetaOntologyBackendAdapter } from "./createFoundryMetaOntologyBackendAdapter.js";

vi.mock("@tanstack/query-db-collection", async (importOriginal) => {
    const original = await importOriginal<typeof import("@tanstack/query-db-collection")>();
    return {
        ...original,
        queryCollectionOptions: vi.fn(original.queryCollectionOptions),
    };
});

const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ri.ontology.main.ontology.example",
    tokenProvider: () => Promise.resolve("token"),
    fetch: globalThis.fetch,
};

beforeEach(() => {
    vi.mocked(queryCollectionOptions).mockClear();
});

describe("Foundry metadata refetch interval", () => {
    it.each([30_000, false, undefined] as const)(
        "forwards %s to every query collection while sharing the entity snapshot",
        async (refetchInterval) => {
            const adapter = createFoundryMetaOntologyBackendAdapter({
                client,
                ...(refetchInterval === undefined ? {} : { refetchInterval }),
            });

            try {
                for (const objectType of [
                    "ObjectType",
                    "ValueType",
                    "LinkType",
                    "ActionType",
                    "QueryFunctionType",
                ]) {
                    adapter.getCollectionOptions(objectType);
                }

                expect(queryCollectionOptions).toHaveBeenCalledTimes(3);
                for (const collection of ["metadata", "actionTypes", "queryFunctionTypes"]) {
                    expect(queryCollectionOptions).toHaveBeenCalledWith(
                        expect.objectContaining({
                            queryKey: ["foundry", "ontology", collection],
                            refetchInterval,
                        })
                    );
                }
            } finally {
                await adapter.cleanup?.();
            }
        }
    );
});
