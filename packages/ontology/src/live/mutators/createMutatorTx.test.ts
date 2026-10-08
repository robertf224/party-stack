import { createCollection, createTransaction, eq, localOnlyCollectionOptions } from "@tanstack/db";
import { describe, expect, it } from "vitest";
import { createMutatorTx } from "./createMutatorTx.js";
import type { OntologyObject } from "../objects/OntologyObject.js";

describe("createMutatorTx", () => {
    it("queries local data and observes earlier writes", async () => {
        const tasks = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
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
        void transaction.isPersisted.promise.catch(() => undefined);
        const tx = createMutatorTx({
            transaction,
            objects: { Task: tasks },
        });

        await tx.mutate.Task!.update("task-1", {
            title: "After",
        });
        const result = await tx.query<{ title: string } | undefined>((query, objects) =>
            query
                .from({ task: objects.Task! })
                .where(({ task }) => eq(task.id, "task-1"))
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
        const tasks = createCollection<OntologyObject, string | number>({
            id: "lazy-tasks",
            getKey: (task) => task.id as string,
            syncMode: "on-demand",
            sync: {
                sync: ({ begin, write, commit, markReady }) => {
                    markReady();
                    return {
                        loadSubset: () => {
                            subsetLoads += 1;
                            begin();
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
        void transaction.isPersisted.promise.catch(() => undefined);
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

    it("sets a previously absent structured property from a property change", async () => {
        const tasks = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
                id: "structured-tasks",
                getKey: (task) => task.id as string,
                initialData: [{ id: "task-1" }],
            })
        );
        await tasks.preload();
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: () => Promise.resolve(),
        });
        void transaction.isPersisted.promise.catch(() => undefined);
        const tx = createMutatorTx({
            transaction,
            objects: { Task: tasks },
        });
        const entries = [
            { code: "alpha", enabled: true },
            { code: "beta", enabled: false },
        ];

        await tx.mutate.Task!.update("task-1", [
            {
                path: ["entries"],
                value: entries,
            },
        ]);

        expect(tasks.get("task-1")?.entries).toEqual(entries);
        transaction.rollback();
        await tasks.cleanup();
    });

    it("sets a nested field beneath a previously absent property", async () => {
        const tasks = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
                id: "sparse-tasks",
                getKey: (task) => task.id as string,
                initialData: [{ id: "task-1" }],
            })
        );
        await tasks.preload();
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: () => Promise.resolve(),
        });
        void transaction.isPersisted.promise.catch(() => undefined);
        const tx = createMutatorTx({
            transaction,
            objects: { Task: tasks },
        });

        await tx.mutate.Task!.update("task-1", [
            {
                path: ["configuration", "theme"],
                value: "dark",
            },
            {
                path: ["configuration", "density"],
                value: "compact",
            },
        ]);

        expect(tasks.get("task-1")?.configuration).toEqual({
            theme: "dark",
            density: "compact",
        });
        transaction.rollback();
        await tasks.cleanup();
    });

    it("rejects property paths that traverse a list as a struct", async () => {
        const tasks = createCollection(
            localOnlyCollectionOptions<OntologyObject, string | number>({
                id: "invalid-path-tasks",
                getKey: (task) => task.id as string,
                initialData: [
                    {
                        id: "task-1",
                        labels: [],
                    },
                ],
            })
        );
        await tasks.preload();
        const transaction = createTransaction({
            autoCommit: false,
            mutationFn: () => Promise.resolve(),
        });
        void transaction.isPersisted.promise.catch(() => undefined);
        const tx = createMutatorTx({
            transaction,
            objects: { Task: tasks },
        });

        await expect(
            tx.mutate.Task!.update("task-1", [
                {
                    path: ["labels", "name"],
                    value: "invalid",
                },
            ])
        ).rejects.toThrow('Cannot assign property path "labels.name": "labels" is not a struct object.');

        transaction.rollback();
        await tasks.cleanup();
    });
});
