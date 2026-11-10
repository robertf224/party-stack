import { defineListFragment, useListFragment } from "@party-stack/ontology-react";
import { Query, eq, ilike, or } from "@tanstack/db";
import { objects } from "../ontology/generated/collections";
import { SearchResult, searchResultFragment } from "./SearchResult";
import { GlassButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";

const searchResults = defineListFragment(objects.Note, (scope, { search = "" }) => {
    let query = scope.where(({ row }) => eq(row.trashed, false));
    if (search.trim())
        query = query.where(({ row }) =>
            or(ilike(row.title, `%${search.trim()}%`), ilike(row.bodyMarkdown, `%${search.trim()}%`))
        );
    return query
        .orderBy(({ row }) => row.updatedAt, "desc")
        .orderBy(({ row }) => row.id, "asc")
        .limit(30)
        .select(({ row }) => ({ id: row.id, result: searchResultFragment.include(row) }));
});
export function Results({ search, close }: { search: string; close: () => void }) {
    const { reportError } = useWorkspace();
    const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useListFragment(
        searchResults.query(new Query().from({ row: objects.Note }), { search })
    );
    return data.length ? (
        <>
            <ul aria-label="Search results">
                {data.map((note) => (
                    <li key={note.id}>
                        <SearchResult note={note.result} close={close} />
                    </li>
                ))}
            </ul>
            {hasNextPage && (
                <GlassButton
                    disabled={isFetchingNextPage}
                    onClick={() => void fetchNextPage().catch((cause) => reportError(textError(cause)))}
                >
                    {isFetchingNextPage ? "Loading…" : "Load more"}
                </GlassButton>
            )}
        </>
    ) : (
        <p className="search-empty">No matching notes</p>
    );
}
