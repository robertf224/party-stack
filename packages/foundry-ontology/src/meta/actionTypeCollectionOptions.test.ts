import {
    FoundryError,
    type OntologyClient,
} from "@party-stack/foundry-client";
import { and, eq, IR } from "@tanstack/db";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { isNotDeclarativeActionType, loadActionTypeCollectionRows } from "./actionTypeCollectionOptions.js";
import type { ActionTypeV2 } from "@osdk/foundry.ontologies";

const mocks = vi.hoisted(() => ({
    getByRid: vi.fn(),
    search: vi.fn(),
    getFullMetadata: vi.fn(),
}));

vi.mock("@osdk/foundry.ontologies", () => ({
    ActionTypesV2: {
        getByRid: mocks.getByRid,
        search: mocks.search,
    },
    ActionTypesFullMetadata: {
        get: mocks.getFullMetadata,
    },
}));

function actionType(overrides: Partial<ActionTypeV2> = {}): ActionTypeV2 {
    return {
        apiName: "streamline-create-token",
        status: "EXPERIMENTAL",
        parameters: {},
        rid: "ri.actions.main.action-type.c38c41b6-46be-42d0-8f07-2d3e424de2ea",
        operations: [],
        ...overrides,
    };
}

function client(): OntologyClient {
    return {
        baseUrl: "https://foundry.example.com",
        ontologyRid: "ri.ontology.main.ontology.example",
        tokenProvider: () => Promise.resolve("token"),
        fetch: globalThis.fetch,
    };
}

beforeEach(() => {
    mocks.getByRid.mockReset();
    mocks.search.mockReset();
    mocks.getFullMetadata.mockReset();
});

describe("isNotDeclarativeActionType", () => {
    it("treats empty operations as non-declarative", () => {
        expect(isNotDeclarativeActionType(actionType())).toBe(true);
    });

    it("treats actions with operations as declarative", () => {
        expect(
            isNotDeclarativeActionType(
                actionType({
                    apiName: "create-task",
                    operations: [{ type: "createObject", objectTypeApiName: "Task" }],
                })
            )
        ).toBe(false);
    });
});

describe("loadActionTypeCollectionRows RID pushdown", () => {
    it("resolves eq(ActionType.id, rid) via getByRid then full metadata", async () => {
        mocks.getByRid.mockResolvedValue({
            apiName: "create-task",
            displayName: "Create task",
            status: "ACTIVE",
            parameters: {},
            rid: "ri.actions.main.action-type.create",
            operations: [{ type: "createObject", objectTypeApiName: "Task" }],
        });
        mocks.getFullMetadata.mockResolvedValue({
            actionType: {
                apiName: "create-task",
                displayName: "Create task",
                status: "ACTIVE",
                parameters: {},
                rid: "ri.actions.main.action-type.create",
                operations: [{ type: "createObject", objectTypeApiName: "Task" }],
            },
            fullLogicRules: [],
        });

        const rows = await loadActionTypeCollectionRows(client(), {
            where: eq(new IR.PropRef<string>(["id"]), "ri.actions.main.action-type.create"),
        });

        expect(mocks.getByRid).toHaveBeenCalledWith(
            expect.anything(),
            "ri.ontology.main.ontology.example",
            "ri.actions.main.action-type.create"
        );
        expect(mocks.search).not.toHaveBeenCalled();
        expect(mocks.getFullMetadata).toHaveBeenCalledWith(
            expect.anything(),
            "ri.ontology.main.ontology.example",
            "create-task",
            { preview: true }
        );
        expect(rows).toEqual([
            expect.objectContaining({
                name: "createTask",
                id: "ri.actions.main.action-type.create",
                displayName: "Create task",
            }),
        ]);
    });

    it("uses search pushdown for displayName filters", async () => {
        mocks.search.mockResolvedValue({
            data: [
                {
                    apiName: "create-task",
                    displayName: "Create task",
                    status: "ACTIVE",
                    parameters: {},
                    rid: "ri.actions.main.action-type.create",
                    operations: [],
                },
            ],
            nextPageToken: undefined,
        });

        const rows = await loadActionTypeCollectionRows(client(), {
            where: eq(new IR.PropRef<string>(["displayName"]), "Create task"),
        });

        expect(mocks.search).toHaveBeenCalled();
        expect(mocks.getByRid).not.toHaveBeenCalled();
        expect(mocks.getFullMetadata).not.toHaveBeenCalled();
        expect(rows).toEqual([
            expect.objectContaining({
                name: "createTask",
                id: "ri.actions.main.action-type.create",
            }),
        ]);
    });

    it("uses search pushdown for RID combined with another predicate", async () => {
        mocks.search.mockResolvedValue({
            data: [
                {
                    apiName: "create-task",
                    displayName: "Create task",
                    status: "ACTIVE",
                    parameters: {},
                    rid: "ri.actions.main.action-type.create",
                    operations: [],
                },
            ],
            nextPageToken: undefined,
        });

        const rows = await loadActionTypeCollectionRows(client(), {
            where: and(
                eq(
                    new IR.PropRef<string>(["id"]),
                    "ri.actions.main.action-type.create"
                ),
                eq(new IR.PropRef<string>(["name"]), "createTask")
            ),
        });

        expect(mocks.getByRid).not.toHaveBeenCalled();
        expect(mocks.search).toHaveBeenCalledWith(
            expect.anything(),
            "ri.ontology.main.ontology.example",
            expect.objectContaining({
                where: {
                    type: "and",
                    value: [
                        {
                            type: "actionTypeRid",
                            value: "ri.actions.main.action-type.create",
                        },
                        {
                            type: "actionTypeApiName",
                            value: { type: "exact", value: "create-task" },
                        },
                    ],
                },
            }),
            { preview: true }
        );
        expect(rows).toEqual([
            expect.objectContaining({
                id: "ri.actions.main.action-type.create",
                name: "createTask",
            }),
        ]);
    });

    it("returns empty results for missing RID lookups", async () => {
        mocks.getByRid.mockRejectedValue({
            statusCode: 404,
            errorCode: "NOT_FOUND",
            message: "missing",
        });

        const rows = await loadActionTypeCollectionRows(client(), {
            where: eq(new IR.PropRef<string>(["id"]), "ri.actions.main.action-type.missing"),
        });

        expect(rows).toEqual([]);
    });

    it("normalizes action search failures", async () => {
        mocks.search.mockRejectedValue({
            statusCode: 403,
            errorCode: "PERMISSION_DENIED",
            errorName: "ActionTypePermissionDenied",
            message: "Not allowed to search actions.",
        });

        const error = await loadActionTypeCollectionRows(client()).then(
            () => undefined,
            (cause: unknown) => cause
        );

        expect(error).toBeInstanceOf(FoundryError);
        expect(error).toMatchObject({
            statusCode: 403,
            errorCode: "PERMISSION_DENIED",
            errorName: "ActionTypePermissionDenied",
        });
    });
});
