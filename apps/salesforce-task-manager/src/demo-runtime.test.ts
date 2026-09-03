import { describe, expect, it, vi } from "vitest";
import { createTaskManagerBackend } from "./demo-runtime.js";

describe("createTaskManagerBackend", () => {
    it("executes generated Task actions through Salesforce CRUD", async () => {
        const createRecord = vi.fn(() =>
            Promise.resolve({
                success: true as const,
                id: "00T000000000001",
                errors: [],
            })
        );
        const updateRecord = vi.fn(() =>
            Promise.resolve({
                success: true as const,
                id: "00T000000000001",
                errors: [],
            })
        );
        const deleteRecord = vi.fn(() =>
            Promise.resolve({
                success: true as const,
                id: "00T000000000001",
                errors: [],
            })
        );
        const invalidate = vi.fn();
        const deleteByKey = vi.fn(() =>
            Promise.resolve()
        );
        const backend = createTaskManagerBackend({
            createRecord,
            updateRecord,
            deleteRecord,
        } as never);
        const live = {
            objects: {
                Task: {
                    utils: {
                        invalidate,
                        deleteByKey,
                    },
                },
            },
        } as never;
        const input = {
            subject: "Generated ontology POC",
            status: "In Progress",
            priority: "High",
            activityDate: "2026-09-01",
        };

        await backend.applyAction(
            "createTask",
            input,
            live
        );
        await backend.applyAction(
            "updateTask",
            {
                task: "00T000000000001",
                ...input,
                status: "Completed",
            },
            live
        );
        await backend.applyAction(
            "deleteTask",
            {
                task: "00T000000000001",
            },
            live
        );

        expect(createRecord).toHaveBeenCalledWith(
            "Task",
            {
                Subject: input.subject,
                Status: input.status,
                Priority: input.priority,
                ActivityDate:
                    input.activityDate,
            }
        );
        expect(updateRecord).toHaveBeenCalledWith(
            "Task",
            "00T000000000001",
            expect.objectContaining({
                Status: "Completed",
            })
        );
        expect(deleteRecord).toHaveBeenCalledWith(
            "Task",
            "00T000000000001"
        );
        expect(invalidate).toHaveBeenCalledTimes(2);
        expect(deleteByKey).toHaveBeenCalledWith(
            "00T000000000001"
        );
    });
});
