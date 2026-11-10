import { expect, test, vi } from "vite-plus/test";
import { searchFoundryObjects } from "./foundryObjectSearch.js";
import type { OntologyClient } from "@party-stack/foundry-client";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@osdk/foundry.ontologies", () => ({ OntologyObjectsV2: { search: mocks.search } }));
const client = { baseUrl: "https://foundry.example/", ontologyRid: "ontology" } as OntologyClient;

test.each([{ data: null }, { data: [{}], nextPageToken: 123 }, {}])(
    "rejects malformed provider pages: %j",
    async (page) => {
        mocks.search.mockReset().mockResolvedValue(page);
        await expect(searchFoundryObjects(client, "Issue", ["id"], {})).rejects.toMatchObject({
            kind: "InvalidResponse",
            retryable: false,
        });
        expect(mocks.search).toHaveBeenCalledOnce();
    }
);

test("rejects repeated provider cursors without looping or returning partial rows", async () => {
    mocks.search.mockReset().mockResolvedValue({ data: [{ id: "one" }], nextPageToken: "same" });
    await expect(searchFoundryObjects(client, "Issue", ["id"], {})).rejects.toMatchObject({
        kind: "InvalidResponse",
        retryable: false,
    });
    expect(mocks.search).toHaveBeenCalledTimes(2);
});

test("classifies a provider row codec failure as an invalid response", async () => {
    mocks.search.mockReset().mockResolvedValue({ data: [{ id: "one" }] });
    await expect(
        searchFoundryObjects(client, "Issue", ["id"], {}, () => {
            throw new Error("bad timestamp");
        })
    ).rejects.toMatchObject({ kind: "InvalidResponse", retryable: false });
});
