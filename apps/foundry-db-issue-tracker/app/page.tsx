"use client";

import { createUsersCollection } from "@bobbyfidz/foundry-db/users";
import { createClient } from "@osdk/client";
import { and, concat, gt, ilike, or, useLiveSuspenseQuery } from "@tanstack/react-db";
import { useState } from "react";
import { ClientOnly } from "./ClientOnly";
import { createObjectsCollection } from "@bobbyfidz/foundry-db/objects";

const client = createClient(
    process.env.NEXT_PUBLIC_FOUNDRY_URL!,
    process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    () => Promise.resolve(process.env.NEXT_PUBLIC_FOUNDRY_TOKEN!)
);
const $users = createUsersCollection({ client });
const $contactResponses = createObjectsCollection({
    client,
    ontologyRid: process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    objectType: "ContactResponse",
});

//

function Home() {
    const [query, setQuery] = useState("");
    const { data: users } = useLiveSuspenseQuery(
        (q) =>
            q
                .from({ $users })
                .where(({ $users }) =>
                    or(ilike($users.givenName, `${query}%`), ilike($users.familyName, `${query}%`))
                )
                .select(({ $users }) => ({
                    name: concat($users.givenName, " ", $users.familyName),
                    ...$users,
                }))
                .limit(10)
                .orderBy(({ $users }) => $users.id, "asc"),
        [query]
    );
    const { data: contactResponses } = useLiveSuspenseQuery((q) =>
        q
            .from({ $contactResponses })
            .where(({ $contactResponses }) =>
                and(
                    ilike($contactResponses.name, `Rob%`),
                    gt($contactResponses.createdAt, "2025-10-24T08:08:08.533Z")
                )
            )
    );

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
            <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-between bg-white px-16 py-32 sm:items-start dark:bg-black">
                <input placeholder="Search..." value={query} onChange={(e) => setQuery(e.target.value)} />
                <div className="flex gap-5">
                    <ul>
                        {users.map((user) => (
                            <li key={user.id}>
                                {user.name} - {user.email}
                            </li>
                        ))}
                    </ul>
                    <ul>
                        {contactResponses.map((contactResponse) => (
                            <li key={contactResponse.__primaryKey}>
                                {contactResponse.name} - {contactResponse.email}
                            </li>
                        ))}
                    </ul>
                </div>
            </main>
        </div>
    );
}

export default ClientOnly(Home);
