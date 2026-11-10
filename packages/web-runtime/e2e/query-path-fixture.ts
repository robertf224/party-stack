import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { eq, field, and } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";

export const count = 1_400;
export const targetId = "note-0000";
export const properties = ["id", "title", "bodyMarkdown", "notebookId", "updatedAt", "favorite", "trashed"];
export const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: properties.map((name) => ({
                name,
                displayName: name,
                type: name === "favorite" || name === "trashed" ? o.boolean({}) : o.string({}),
            })),
        },
    ],
    actionTypes: [
        { name: "seed", displayName: "Seed", parameters: [], logic: [] },
        {
            name: "edit",
            displayName: "Edit",
            parameters: ["id", "bodyMarkdown"].map((name) => ({
                name,
                displayName: name,
                type: o.string({}),
            })),
            logic: [],
        },
    ],
};
export const row = (index: number) => ({
    id: `note-${String(index).padStart(4, "0")}`,
    title: `A local note ${index}`,
    bodyMarkdown: `A reasonably sized note ${index}. ` + "Local data and speculative edits. ".repeat(12),
    notebookId: "notes",
    updatedAt: `2026-11-08T${String(Math.floor(index / 60) % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    favorite: false,
    trashed: true,
});
const orderBy = [
    { field: field("favorite"), direction: "desc" as const, nulls: "first" as const },
    { field: field("updatedAt"), direction: "desc" as const, nulls: "first" as const },
    { field: field("id"), direction: "asc" as const, nulls: "first" as const },
];
// Both paths receive this exact aggregate union, including the unbounded boolean tie.
export const subsets: CompiledSubset[] = [
    { objectType: "Note", query: { where: eq(field("trashed"), true), orderBy, limit: 51 } },
    {
        objectType: "Note",
        query: { where: and(eq(field("trashed"), true), eq(field("favorite"), false)), orderBy },
    },
    { objectType: "Note", query: { where: eq(field("id"), targetId) } },
];
export const document = {
    select: subsets.map((subset, index) =>
        q.sub(`subset${index}`, {
            ...objectSubset(subset.objectType, subset.query),
            select: properties.map((name) => q.selectField(name, q.field("row", name))),
        })
    ),
};
export const execute = Effect.fnUntraced(function* (tx: OwnedTransaction, request: ActionRequest) {
    if (request.name === "seed") {
        for (let index = 0; index < count; index++) yield* tx.put("Note", row(index));
    } else {
        const before = yield* tx.get("Note", String(request.parameters.id));
        if (!before) throw new Error("Missing benchmark note.");
        yield* tx.put("Note", { ...before, bodyMarkdown: request.parameters.bodyMarkdown });
    }
});
