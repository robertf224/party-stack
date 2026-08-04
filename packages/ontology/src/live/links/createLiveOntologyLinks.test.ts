import { BasicIndex, createCollection, type Collection } from "@tanstack/db";
import { describe, expect, it, vi } from "vitest";
import { o } from "../../ir/index.js";
import { createLiveOntologyLinks } from "./createLiveOntologyLinks.js";
import { OntologyLinkError } from "./resolveOntologyLink.js";
import type { OntologyIR } from "../../ir/index.js";

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
                { name: "departmentId", displayName: "Department", type: o.string({}) },
            ],
        },
        {
            name: "Department",
            displayName: "Department",
            pluralDisplayName: "Departments",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
    linkTypes: [
        {
            id: "ri.link.employee-department",
            source: {
                objectType: "Employee",
                name: "employees",
                displayName: "Employees",
                cardinality: "many",
            },
            target: {
                objectType: "Department",
                name: "department",
                displayName: "Department",
                cardinality: "one",
            },
            foreignKey: "departmentId",
            cardinality: "many",
        },
        {
            id: "ri.link.non-fk",
            source: {
                objectType: "Employee",
                name: "peerOf",
                displayName: "Peer of",
                cardinality: "many",
            },
            target: {
                objectType: "Employee",
                name: "peers",
                displayName: "Peers",
                cardinality: "many",
            },
            cardinality: "many",
        },
    ],
    actionTypes: [],
    queryFunctionTypes: [],
};

function memoryCollection(
    rows: Record<string, unknown>[],
    primaryKey: string,
    loadSubset = vi.fn()
): Collection<Record<string, unknown>> {
    let loaded = false;
    return createCollection<Record<string, unknown>>({
        getKey: (row) => row[primaryKey] as string | number,
        defaultIndexType: BasicIndex,
        autoIndex: "eager" as const,
        syncMode: "on-demand",
        sync: {
            sync: ({ begin, write, commit, markReady }) => {
                markReady();
                return {
                    loadSubset: () => {
                        loadSubset();
                        if (loaded) return true;
                        loaded = true;
                        begin();
                        for (const row of rows) {
                            write({ type: "insert", value: row });
                        }
                        commit();
                        return true;
                    },
                    cleanup: () => undefined,
                };
            },
        },
    });
}

describe("createLiveOntologyLinks", () => {
    it("follows FK one/one and reverse one/many locally", async () => {
        const loadEmployees = vi.fn();
        const loadDepartments = vi.fn();
        const employees = memoryCollection(
            [
                { id: "e1", name: "Ada", departmentId: "d1" },
                { id: "e2", name: "Grace", departmentId: "d1" },
                { id: "e3", name: "Linus", departmentId: "d2" },
            ],
            "id",
            loadEmployees
        );
        const departments = memoryCollection(
            [
                { id: "d1", name: "Eng" },
                { id: "d2", name: "Sales" },
            ],
            "id",
            loadDepartments
        );

        const links = createLiveOntologyLinks({
            ir,
            objects: {
                Employee: employees,
                Department: departments,
            },
        });

        await expect(
            links.get({ objectType: "Employee", primaryKey: "e1", link: "department" })
        ).resolves.toEqual({
            objectType: "Department",
            primaryKey: "d1",
            properties: { id: "d1", name: "Eng" },
        });
        expect(loadEmployees).toHaveBeenCalled();
        expect(loadDepartments).toHaveBeenCalled();

        const firstPage = await links.list({
            objectType: "Department",
            primaryKey: "d1",
            link: "employees",
            pageSize: 1,
            select: ["name"],
        });
        expect(firstPage).toEqual({
            objects: [
                {
                    objectType: "Employee",
                    primaryKey: "e1",
                    properties: { id: "e1", name: "Ada" },
                },
            ],
            nextPageToken: "local-fk:1",
        });
        await expect(
            links.list({
                objectType: "Department",
                primaryKey: "d1",
                link: "employees",
                pageSize: 1,
                pageToken: firstPage.nextPageToken,
                select: ["name"],
            })
        ).resolves.toEqual({
            objects: [
                {
                    objectType: "Employee",
                    primaryKey: "e2",
                    properties: { id: "e2", name: "Grace" },
                },
            ],
            nextPageToken: undefined,
        });

        await expect(
            links.get({
                objectType: "Department",
                primaryKey: "d1",
                link: "employees",
                linkedPrimaryKey: "e2",
                select: ["name"],
            })
        ).resolves.toEqual({
            objectType: "Employee",
            primaryKey: "e2",
            properties: { id: "e2", name: "Grace" },
        });
    });

    it("falls back to the backend for non-FK links", async () => {
        const backendList = vi.fn(() =>
            Promise.resolve({
                objects: [
                    {
                        objectType: "Employee",
                        primaryKey: "e9",
                        properties: { id: "e9" },
                    },
                ],
            })
        );
        const links = createLiveOntologyLinks({
            ir,
            objects: {
                Employee: memoryCollection([{ id: "e1" }], "id"),
            },
            backendLinks: {
                list: backendList,
                get: vi.fn(),
            },
        });

        await expect(
            links.list({ objectType: "Employee", primaryKey: "e1", link: "peers" })
        ).resolves.toEqual({
            objects: [{ objectType: "Employee", primaryKey: "e9", properties: { id: "e9" } }],
        });
        expect(backendList).toHaveBeenCalledWith(
            expect.objectContaining({
                objectType: "Employee",
                primaryKey: "e1",
                link: { sideName: "peers" },
            })
        );
    });

    it("errors when a non-FK link has no backend", async () => {
        const links = createLiveOntologyLinks({
            ir,
            objects: {
                Employee: memoryCollection([{ id: "e1" }], "id"),
            },
        });

        await expect(
            links.list({ objectType: "Employee", primaryKey: "e1", link: "peers" })
        ).rejects.toBeInstanceOf(OntologyLinkError);
    });
});
