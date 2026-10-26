import { createMetaLiveOntology } from "@party-stack/ontology";
import { eq, ilike, queryOnce } from "@tanstack/db";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceMetaOntologyBackendAdapter } from "./createSalesforceMetaOntologyBackendAdapter.js";

describe("Salesforce ActionType metadata queries", () => {
    it("describes an exact action without listing every action", async () => {
        const listFlowActions = vi.fn();
        const listStandardActions = vi.fn();
        const describeFlowAction = vi.fn().mockResolvedValue({
            name: "Create_Lead",
            label: "Create Lead",
            inputs: [],
        });
        const describeStandardAction = vi.fn().mockRejectedValue(new Error("Not a standard action"));
        const meta = await createMetaLiveOntology({
            backend: () =>
                createSalesforceMetaOntologyBackendAdapter({
                    client: {
                        listFlowActions,
                        listStandardActions,
                        describeFlowAction,
                        describeStandardAction,
                    } as never,
                }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q
                    .from({
                        ActionType: meta.objects.ActionType,
                    })
                    .where(({ ActionType }) => eq(ActionType.name, "Create_Lead"))
            );

            expect(listFlowActions).not.toHaveBeenCalled();
            expect(listStandardActions).not.toHaveBeenCalled();
            expect(describeFlowAction).toHaveBeenCalledExactlyOnceWith("Create_Lead");
            expect(rows[0]).toMatchObject({
                name: "Create_Lead",
                displayName: "Create Lead",
            });
        } finally {
            await meta.cleanup();
        }
    });

    it("lists names then batch-describes only matching actions", async () => {
        const listFlowActions = vi.fn().mockResolvedValue([
            {
                name: "Create_Lead",
                label: "Create Lead",
            },
            {
                name: "Unrelated_Flow",
                label: "Unrelated Flow",
            },
        ]);
        const listStandardActions = vi.fn().mockResolvedValue([
            {
                name: "confirmSalesMeeting",
                label: "Confirm Sales Meeting",
            },
        ]);
        const describeFlowActions = vi.fn().mockResolvedValue([
            {
                name: "Create_Lead",
                label: "Create Lead",
                inputs: [
                    {
                        name: "company",
                        type: "STRING",
                        required: true,
                    },
                ],
            },
        ]);
        const describeStandardActions = vi.fn().mockResolvedValue([]);
        const describeFlowAction = vi.fn();
        const describeStandardAction = vi.fn();
        const meta = await createMetaLiveOntology({
            backend: () =>
                createSalesforceMetaOntologyBackendAdapter({
                    client: {
                        listFlowActions,
                        listStandardActions,
                        describeFlowActions,
                        describeStandardActions,
                        describeFlowAction,
                        describeStandardAction,
                    } as never,
                }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q
                    .from({
                        ActionType: meta.objects.ActionType,
                    })
                    .where(({ ActionType }) => ilike(ActionType.name, "%Lead%"))
                    .orderBy(({ ActionType }) => ActionType.name, "asc")
                    .limit(50)
            );

            expect(rows).toMatchObject([
                {
                    name: "Create_Lead",
                    parameters: [{ name: "company" }],
                },
            ]);
            expect(describeFlowActions).toHaveBeenCalledExactlyOnceWith(["Create_Lead"]);
            expect(describeStandardActions).not.toHaveBeenCalled();
            expect(describeFlowAction).not.toHaveBeenCalled();
            expect(describeStandardAction).not.toHaveBeenCalled();
        } finally {
            await meta.cleanup();
        }
    });

    it("loads configured CRUD actions without probing invocable action APIs", async () => {
        const describeFlowAction = vi.fn();
        const describeStandardAction = vi.fn();
        const describeSObject = vi.fn().mockResolvedValue({
            name: "Task",
            label: "Task",
            labelPlural: "Tasks",
            createable: true,
            updateable: true,
            deletable: true,
            queryable: true,
            fields: [
                {
                    name: "Subject",
                    label: "Subject",
                    type: "string",
                    nillable: false,
                    createable: true,
                    updateable: true,
                    calculated: false,
                    autoNumber: false,
                    defaultedOnCreate: false,
                    picklistValues: [],
                },
            ],
        });
        const meta = await createMetaLiveOntology({
            backend: () =>
                createSalesforceMetaOntologyBackendAdapter({
                    client: {
                        describeFlowAction,
                        describeStandardAction,
                        describeSObject,
                    } as never,
                    crudActionTypes: [
                        {
                            objectType: "Task",
                            operations: ["create"],
                        },
                    ],
                }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q
                    .from({
                        ActionType: meta.objects.ActionType,
                    })
                    .where(({ ActionType }) => eq(ActionType.name, "createTask"))
            );

            expect(rows[0]).toMatchObject({
                name: "createTask",
                parameters: [{ name: "Subject" }],
            });
            expect(describeSObject).toHaveBeenCalledExactlyOnceWith("Task");
            expect(describeFlowAction).not.toHaveBeenCalled();
            expect(describeStandardAction).not.toHaveBeenCalled();
        } finally {
            await meta.cleanup();
        }
    });
});
