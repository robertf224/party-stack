import {
    createCollection,
    createTransaction,
    eq,
    localOnlyCollectionOptions,
} from "@tanstack/db";
import { describe, expect, it } from "vitest";
import { createMutatorTx } from "./createMutatorTx.js";
import type { OntologyObject } from "../objects/OntologyObject.js";

describe("createMutatorTx", () => {
    it("queries local data and observes earlier writes", async () => {
        const tasks = createCollection(
            localOnlyCollectionOptions<
                OntologyObject,
                string | number
            >({
                id: "tasks",
                getKey: (task) => task.id as string,
                initialData: [
                    {
                        id: "task-1",
                        title: "Before",
                    },
                ],
            })
        );
        await tasks.preload();
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: () => Promise.resolve(),
        });
        void transaction.isPersisted.promise.catch(
            () => undefined
        );
        const tx = createMutatorTx({
            transaction,
            objects: { Task: tasks },
        });

        await tx.mutate.Task!.update("task-1", {
            title: "After",
        });
        const result = await tx.query<
            { title: string } | undefined
        >(
            (query, objects) =>
                query
                    .from({ task: objects.Task! })
                    .where(({ task }) =>
                        eq(task.id, "task-1")
                    )
                    .select(({ task }) => ({
                        title: task.title,
                    }))
                    .findOne()
        );

        expect(result?.title).toBe("After");
        expect(tasks.get("task-1")?.title).toBe("After");
        transaction.rollback();
        expect(tasks.get("task-1")?.title).toBe("Before");
        await tasks.cleanup();
    });

    it("loads a referenced object on demand before updating it", async () => {
        let subsetLoads = 0;
        const tasks = createCollection<
            OntologyObject,
            string | number
        >({
            id: "lazy-tasks",
            getKey: (task) => task.id as string,
            syncMode: "on-demand",
            sync: {
                sync: ({
                    begin,
                    write,
                    commit,
                    markReady,
                }) => {
                    markReady();
                    return {
                        loadSubset: () => {
                            subsetLoads += 1;
                            begin({
                                immediate: true,
                            });
                            write({
                                type: "insert",
                                value: {
                                    id: "task-1",
                                    title: "Before",
                                },
                            });
                            return commit();
                        },
                    };
                },
            },
        });
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: () => Promise.resolve(),
        });
        void transaction.isPersisted.promise.catch(
            () => undefined
        );
        const tx = createMutatorTx({
            transaction,
            objects: { Task: tasks },
            primaryKeys: { Task: "id" },
        });

        await tx.mutate.Task!.update("task-1", {
            title: "After",
        });

        expect(subsetLoads).toBe(1);
        expect(tasks.get("task-1")?.title).toBe("After");
        transaction.rollback();
        await tasks.cleanup();
    });
});
