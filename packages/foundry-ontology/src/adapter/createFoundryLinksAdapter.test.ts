import { o, OntologyLinkError, type OntologyIR } from "@party-stack/ontology";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import { createFoundryLinksAdapter } from "./createFoundryLinksAdapter.js";
import { createFoundryCodec } from "./foundryCodec.js";

const mocks = vi.hoisted(() => ({
    listLinkedObjects: vi.fn(),
    getLinkedObject: vi.fn(),
}));

vi.mock("@osdk/foundry.ontologies", () => ({
    LinkedObjectsV2: {
        listLinkedObjects: mocks.listLinkedObjects,
        getLinkedObject: mocks.getLinkedObject,
    },
}));

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Employee",
            displayName: "Employee",
            pluralDisplayName: "Employees",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "name", displayName: "Name", type: o.string({}) },
            ],
        },
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
        },
    ],
    linkTypes: [
        {
            id: "ri.link.employee-projects",
            source: {
                objectType: "Employee",
                name: "members",
                displayName: "Members",
                cardinality: "many",
            },
            target: {
                objectType: "Project",
                name: "projects",
                displayName: "Projects",
                cardinality: "many",
            },
            cardinality: "many",
        },
    ],
    actionTypes: [],
    queryFunctionTypes: [],
};

function client(): OntologyClient {
    return {
        baseUrl: "https://foundry.example.com",
        ontologyRid: "ri.ontology.main.ontology.example",
        tokenProvider: () => Promise.resolve("token"),
        fetch: globalThis.fetch,
    };
}

beforeEach(() => {
    mocks.listLinkedObjects.mockReset();
    mocks.getLinkedObject.mockReset();
});

describe("createFoundryLinksAdapter", () => {
    it("lists linked objects through LinkedObjectsV2 and decodes them", async () => {
        mocks.listLinkedObjects.mockResolvedValue({
            data: [{ id: "p1", title: "Launch" }],
            nextPageToken: "next",
        });

        const adapter = createFoundryLinksAdapter({
            client: client(),
            ir,
            codec: createFoundryCodec(ir),
        });

        const page = await adapter.list({
            objectType: "Employee",
            primaryKey: "e1",
            link: { sideName: "projects" },
            pageSize: 50,
            select: ["title"],
        });

        expect(mocks.listLinkedObjects).toHaveBeenCalledWith(
            expect.anything(),
            "ri.ontology.main.ontology.example",
            "Employee",
            "e1",
            "projects",
            expect.objectContaining({
                pageSize: 50,
                select: ["id", "title"],
            })
        );
        expect(page).toEqual({
            objects: [
                {
                    objectType: "Project",
                    primaryKey: "p1",
                    properties: { id: "p1", title: "Launch" },
                },
            ],
            nextPageToken: "next",
        });
    });

    it("gets a linked object by primary key", async () => {
        mocks.getLinkedObject.mockResolvedValue({ id: "p1", title: "Launch" });

        const adapter = createFoundryLinksAdapter({
            client: client(),
            ir,
            codec: createFoundryCodec(ir),
        });

        await expect(
            adapter.get({
                objectType: "Employee",
                primaryKey: "e1",
                link: { sideName: "projects" },
                linkedPrimaryKey: "p1",
            })
        ).resolves.toEqual({
            objectType: "Project",
            primaryKey: "p1",
            properties: { id: "p1", title: "Launch" },
        });
    });

    it("rejects to-many get without linkedPrimaryKey", async () => {
        const adapter = createFoundryLinksAdapter({
            client: client(),
            ir,
            codec: createFoundryCodec(ir),
        });

        await expect(
            adapter.get({
                objectType: "Employee",
                primaryKey: "e1",
                link: { sideName: "projects" },
            })
        ).rejects.toBeInstanceOf(OntologyLinkError);
    });
});
