import { defineFragment, useFragment, type FragmentRef } from "@party-stack/ontology-react";
import { KeyRound, LockKeyhole } from "lucide-react";
import { memo, useDeferredValue } from "react";
import { objects } from "../ontology/generated/collections";
import { NoteMenu, noteMenuFragment } from "./NoteMenu";
import type { createNoteDates } from "./dates";

export const notePreviewFragment = defineFragment(objects.Note, (note) => ({
    id: note.id,
    title: note.title,
    body: note.bodyMarkdown,
    kind: note.kind,
    updatedAt: note.updatedAt,
    menu: noteMenuFragment.include(note),
}));

export const NotePreview = memo(function NotePreview({
    note,
    dates,
    selected,
    onSelect,
    tabIndex,
}: {
    note: FragmentRef<typeof notePreviewFragment>;
    dates: ReturnType<typeof createNoteDates>;
    selected: boolean;
    onSelect: (id: string) => void;
    tabIndex: number;
}) {
    const { data } = useFragment(note);
    // Let React capture the outgoing row before a live include removes it.
    const value = useDeferredValue(data);
    if (!value) return null;
    const body = value.body
        .replace(/!\[[^\]]*\]\(attachment:[^)]+\)/g, "Attachment")
        .replace(/[#*>`[\]_]/g, "")
        .trim();
    const lines = body.split(/\n+/);
    if (lines[0]?.replace(/^\s*(?:[-+] |\d+\. )?/, "").trim() === value.title.trim()) lines.shift();
    const preview = lines.join(" ").trim();
    return (
        <NoteMenu
            note={value.menu}
            contextMenu
            trigger={
                <button
                    className={`note-preview ${selected ? "selected" : ""}`}
                    data-note-id={value.id}
                    role="option"
                    aria-selected={selected}
                    tabIndex={tabIndex}
                    onClick={() => onSelect(value.id)}
                >
                    <div className="preview-title">
                        {value.kind === "secure" ? (
                            <LockKeyhole />
                        ) : value.kind === "login" ? (
                            <KeyRound />
                        ) : null}
                        <strong>{value.title || "Untitled"}</strong>
                    </div>
                    <p>
                        <time dateTime={value.updatedAt.toString()} title={dates.full(value.updatedAt)}>
                            {dates.label(value.updatedAt)}
                        </time>
                        {value.kind === "login"
                            ? "Encrypted login"
                            : value.kind === "secure"
                              ? "Encrypted note"
                              : preview || "No additional text"}
                    </p>
                </button>
            }
        />
    );
});
