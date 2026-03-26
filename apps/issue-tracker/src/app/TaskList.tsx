"use client";

import { concat, eq, ilike, useLiveQuery } from "@tanstack/react-db";
import React, { useState } from "react";
import { flushSync } from "react-dom";
import { User } from "./collections";
import { ontology } from "./collections";
import { useAction } from "./useAction";

function withViewTransition(fn: () => void) {
    if (!document.startViewTransition) {
        fn();
        return;
    }
    document.startViewTransition(() => flushSync(fn));
}

export const TaskList: React.FC = () => {
    const [query, setQuery] = useState("");
    const [title, setTitle] = useState("");
    const createTask = useAction(ontology.actions.createTask);
    const deleteTask = useAction(ontology.actions.deleteTask);
    const completeTask = useAction(ontology.actions.completeTask);
    const reopenTask = useAction(ontology.actions.reopenTask);

    const { data: tasks } = useLiveQuery(
        (q) =>
            q
                .from({ Task: ontology.objects.Task })
                .where(({ Task }) => ilike(Task.title, `${query}%`))
                .join({ User }, ({ Task, User }) => eq(Task.createdBy, User.id))
                .select(({ Task, User }) => ({
                    id: Task.id,
                    title: Task.title,
                    createdBy: concat(User.givenName, " ", User.familyName),
                    createdAt: Task.createdAt,
                    completedAt: Task.completedAt,
                    location: Task.location,
                }))
                .orderBy(({ Task }) => Task.completedAt, "desc")
                .orderBy(({ Task }) => Task.createdAt, "asc")
                .limit(10),
        [query]
    );

    const handleCreateTask = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const nextTitle = title.trim();
        if (!nextTitle) {
            return;
        }

        withViewTransition(() => {
            setTitle("");
            createTask({ title: nextTitle });
        });
    };

    const handleDeleteTask = (taskId: string) => {
        withViewTransition(() => {
            deleteTask({ task: taskId });
        });
    };

    const handleToggleTask = (taskId: string, completedAt: unknown) => {
        withViewTransition(() => {
            if (completedAt) {
                reopenTask({ task: taskId });
                return;
            }
            completeTask({ task: taskId });
        });
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <main className="flex min-h-screen w-full max-w-3xl flex-col items-center gap-10 bg-white px-16 py-32 sm:items-start dark:bg-black">
                <form className="flex w-full max-w-xl gap-3" onSubmit={handleCreateTask}>
                    <input
                        className="flex-1 rounded border border-zinc-300 px-3 py-2"
                        placeholder="Add a task..."
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                    <button
                        className="rounded bg-zinc-900 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
                        disabled={!title.trim()}
                        type="submit"
                    >
                        Create
                    </button>
                </form>
                <input
                    className="w-full max-w-xl rounded border border-zinc-300 px-3 py-2"
                    placeholder="Search..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <ul className="flex w-full max-w-xl flex-col gap-4">
                    {tasks.map((task) => (
                        <li
                            key={task.id}
                            className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                            style={{ viewTransitionName: `task-${task.id}` }}
                        >
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                    <input
                                        checked={Boolean(task.completedAt)}
                                        className="mt-1 h-4 w-4 rounded border-zinc-300"
                                        onChange={() => handleToggleTask(task.id, task.completedAt)}
                                        type="checkbox"
                                    />
                                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                                        <h2
                                            className={`truncate text-base font-semibold ${
                                                task.completedAt
                                                    ? "text-zinc-500 line-through dark:text-zinc-500"
                                                    : "text-zinc-900 dark:text-zinc-100"
                                            }`}
                                        >
                                            {task.title}{" "}
                                            <span className="text-gray-500">
                                                {task.createdAt?.toLocaleString()}
                                            </span>
                                        </h2>
                                        <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                            Created by {task.createdBy}
                                        </p>
                                        {task.completedAt && (
                                            <p className="text-xs text-zinc-500 dark:text-zinc-500">
                                                Completed {String(task.completedAt)}
                                            </p>
                                        )}
                                        <span>{JSON.stringify(task.location)}</span>
                                    </div>
                                </div>
                                <button
                                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
                                    onClick={() => handleDeleteTask(task.id)}
                                    type="button"
                                >
                                    Delete
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            </main>
        </div>
    );
};
