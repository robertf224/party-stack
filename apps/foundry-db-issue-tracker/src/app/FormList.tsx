"use client";

import { concat, eq, ilike, useLiveSuspenseQuery } from "@tanstack/react-db";
import React, { useState } from "react";
import { $form, $formRevision, $user } from "./collections";

export const FormList: React.FC = () => {
    const [query, setQuery] = useState("");
    const { data: forms } = useLiveSuspenseQuery(
        (q) =>
            q
                .from({ $form })
                .where(({ $form }) => ilike($form.title, `${query}%`))
                .limit(10)
                .orderBy(({ $form }) => $form.createdAt, "desc")
                .join({ $formRevision }, ({ $form, $formRevision }) =>
                    eq($form.liveRevisionId, $formRevision.id)
                )
                .join({ $user }, ({ $formRevision, $user }) => eq($formRevision?.createdBy, $user.id))
                .select(({ $form, $user, $formRevision }) => ({
                    id: $form.id,
                    title: $form.title,
                    lastPublishedAt: $formRevision?.createdAt,
                    lastPublishedBy: concat($user?.givenName, " ", $user?.familyName),
                })),
        [query]
    );

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <main className="flex min-h-screen w-full max-w-3xl flex-col items-center gap-10 bg-white px-16 py-32 sm:items-start dark:bg-black">
                <input placeholder="Search..." value={query} onChange={(e) => setQuery(e.target.value)} />
                <ul className="flex flex-col gap-5">
                    {forms.map((form) => (
                        <li key={form.id}>
                            {form.title} - {form.lastPublishedAt} - {form.lastPublishedBy}
                        </li>
                    ))}
                </ul>
            </main>
        </div>
    );
};
