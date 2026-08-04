import { FoundryError, type OntologyClient } from "@party-stack/foundry-client";
import { eq, IR } from "@tanstack/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadQueryFunctionTypeCollectionRows } from "./queryFunctionTypeCollectionOptions.js";

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    list: vi.fn(),
}));

vi.mock("@osdk/foundry.ontologies", () => ({
    QueryTypes: {
        get: mocks.get,
        list: mocks.list,
    },
}));

const client: OntologyClient = {
    baseUrl: "https://foundry.example.com",
    ontologyRid: "ri.ontology.main.ontology.example",
    tokenProvider: () => Promise.resolve("token"),
    fetch: globalThis.fetch,
};

beforeEach(() => {
    mocks.get.mockReset();
    mocks.list.mockReset();
});

describe("loadQueryFunctionTypeCollectionRows", () => {
    it("normalizes list failures", async () => {
        mocks.list.mockRejectedValue({
            statusCode: 403,
            errorCode: "PERMISSION_DENIED",
            message: "Not allowed to list query types.",
        });

        const error = await loadQueryFunctionTypeCollectionRows({ client }).then(
            () => undefined,
            (cause: unknown) => cause
        );

        expect(error).toBeInstanceOf(FoundryError);
        expect(error).toMatchObject({
            statusCode: 403,
            errorCode: "PERMISSION_DENIED",
        });
    });

    it("normalizes exact-name lookup failures", async () => {
        mocks.get.mockRejectedValue({
            statusCode: 404,
            errorCode: "NOT_FOUND",
            message: "Query type missing.",
        });

        const error = await loadQueryFunctionTypeCollectionRows(
            { client },
            {
                where: eq(
                    new IR.PropRef<string>(["name"]),
                    "googleMapsAutocompleteAddress"
                ),
            }
        ).then(
            () => undefined,
            (cause: unknown) => cause
        );

        expect(error).toBeInstanceOf(FoundryError);
        expect(error).toMatchObject({
            statusCode: 404,
            errorCode: "NOT_FOUND",
        });
    });
});
