"use client";

import { concat, eq, ilike, useLiveInfiniteQuery } from "@tanstack/react-db";
import React, { useState } from "react";
import { Task, User } from "./collections";

export const TaskList: React.FC = () => {
    const [query, setQuery] = useState("");
    const { data: tasks } = useLiveInfiniteQuery(
        (q) =>
            q
                .from({ Task })
                .where(({ Task }) => ilike(Task.title, `${query}%`))
                .limit(10)
                .orderBy(({ Task }) => Task.completedAt, "desc")
                .join({ User }, ({ Task, User }) => eq(Task.createdBy, User.id))
                .select(({ Task, User }) => ({
                    id: Task.id,
                    title: Task.title,
                    createdBy: concat(User?.givenName, " ", User.familyName),
                    completedAt: Task.completedAt,
                })),
        {
            getNextPageParam: (page) => page.length,
        },
        [query]
    );

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <main className="flex min-h-screen w-full max-w-3xl flex-col items-center gap-10 bg-white px-16 py-32 sm:items-start dark:bg-black">
                <input placeholder="Search..." value={query} onChange={(e) => setQuery(e.target.value)} />
                <ul className="flex flex-col gap-5">
                    {tasks.map((task) => (
                        <li key={task.id}>
                            {task.title} - {task.createdBy}
                            {task.completedAt && String(task.completedAt)}
                        </li>
                    ))}
                </ul>
            </main>
        </div>
    );
};
