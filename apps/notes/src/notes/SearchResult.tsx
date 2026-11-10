import { defineFragment, useFragment, useOntology, type FragmentRef } from "@party-stack/ontology-react";
import { Link } from "@tanstack/react-router";
import { FileText, KeyRound, LockKeyhole } from "lucide-react";
import { defaultNotebookId } from "../ontology/folders";
import { objects } from "../ontology/generated/collections";
import { noteLocation } from "./navigation";
import type { NotesOntology } from "../ontology/generated/types";

export const searchResultFragment = defineFragment(objects.Note, (note) => ({
    id: note.id,
    notebookId: note.notebookId,
    title: note.title,
    kind: note.kind,
}));

export function SearchResult({
    note,
    close,
}: {
    note: FragmentRef<typeof searchResultFragment>;
    close: () => void;
}) {
    const { data: value } = useFragment(note);
    const ontology = useOntology<NotesOntology>();
    return value ? (
        <Link
            {...noteLocation(
                value.notebookId === defaultNotebookId(ontology.context.userId)
                    ? "all"
                    : `folder:${value.notebookId}`,
                value.id
            )}
            onClick={close}
            onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const links = Array.from(event.currentTarget.closest("ul")!.querySelectorAll("a"));
                const index = links.indexOf(event.currentTarget);
                links[
                    Math.max(0, Math.min(links.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
                ]?.focus();
            }}
        >
            {value.kind === "login" ? <KeyRound /> : value.kind === "secure" ? <LockKeyhole /> : <FileText />}
            <span>{value.title || "Untitled"}</span>
        </Link>
    ) : null;
}
