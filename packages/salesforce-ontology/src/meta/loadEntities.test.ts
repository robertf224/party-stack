import { createMetaLiveOntology } from "@party-stack/ontology";
import { eq, queryOnce } from "@tanstack/db";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceMetaOntologyBackendAdapter } from "./createSalesforceMetaOntologyBackendAdapter.js";

function taskDescribe() {
    return {
        name: "Task",
        label: "Task",
        labelPlural: "Tasks",
        queryable: true,
        fields: [
            {
                name: "Id",
                label: "Task ID",
                type: "id",
                nillable: false,
                referenceTo: [],
            },
            {
                name: "Subject",
                label: "Subject",
                type: "string",
                nillable: true,
                referenceTo: [],
            },
        ],
    };
}

describe("Salesforce ObjectType metadata queries", () => {
    it("pushes exact names into describeSObject without loading the org", async () => {
        const describeGlobal = vi.fn();
        const describeSObject = vi.fn().mockResolvedValue(taskDescribe());
        const meta = await createMetaLiveOntology({
            backend: () =>
                createSalesforceMetaOntologyBackendAdapter({
                    client: {
                        describeGlobal,
                        describeSObject,
                    } as never,
                }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q
                    .from({
                        ObjectType: meta.objects.ObjectType,
                    })
                    .where(({ ObjectType }) => eq(ObjectType.name, "Task"))
            );

            expect(describeGlobal).not.toHaveBeenCalled();
            expect(describeSObject).toHaveBeenCalledWith("Task");
            expect(rows[0]).toMatchObject({
                name: "Task",
                properties: [{ name: "Id" }, { name: "Subject" }],
            });
        } finally {
            await meta.cleanup();
        }
    });

    it("returns complete definitions for global and named queries", async () => {
        const describeGlobal = vi.fn().mockResolvedValue({
            sobjects: [
                {
                    name: "Task",
                    label: "Task",
                    labelPlural: "Tasks",
                    queryable: true,
                },
                {
                    name: "Hidden",
                    label: "Hidden",
                    labelPlural: "Hidden",
                    queryable: false,
                },
            ],
        });
        const describeSObject = vi.fn().mockResolvedValue(taskDescribe());
        const meta = await createMetaLiveOntology({
            backend: () =>
                createSalesforceMetaOntologyBackendAdapter({
                    client: {
                        describeGlobal,
                        describeSObject,
                    } as never,
                }),
            persistObjects: false,
        });

        try {
            const rows = await queryOnce((q) =>
                q.from({
                    ObjectType: meta.objects.ObjectType,
                })
            );

            expect(describeGlobal).toHaveBeenCalledOnce();
            expect(describeSObject).toHaveBeenCalledWith("Task");
            expect(rows).toEqual([
                expect.objectContaining({
                    name: "Task",
                    properties: expect.arrayContaining([expect.objectContaining({ name: "Id" })]),
                }),
            ]);

            const detail = await queryOnce((q) =>
                q
                    .from({
                        ObjectType: meta.objects.ObjectType,
                    })
                    .where(({ ObjectType }) => eq(ObjectType.name, "Task"))
            );
            expect(describeSObject).toHaveBeenCalledWith("Task");
            expect(detail[0]?.properties).toHaveLength(2);
        } finally {
            await meta.cleanup();
        }
    });
});
