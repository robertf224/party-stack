import {
    defineFragment,
    useFragment,
    type FragmentData,
    type FragmentRef,
} from "@party-stack/ontology-react";
import { Share } from "lucide-react";
import { objects } from "../ontology/generated/collections";
import { IconButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";
import type { ContextMenu } from "@base-ui/react/context-menu";
import type { Menu } from "@base-ui/react/menu";

export const noteShareFragment = defineFragment(objects.Note, (note) => ({
    title: note.title,
    body: note.bodyMarkdown,
    kind: note.kind,
}));

async function shareNote(note: FragmentData<typeof noteShareFragment>) {
    if (note.kind !== "note") return;
    const text = note.body.replace(/!\[([^\]]*)\]\(attachment:[^)]+\)/g, "[Attachment: $1]");
    if (typeof navigator.share === "function") await navigator.share({ title: note.title, text });
    else await navigator.clipboard.writeText(text);
}

export function ShareNoteButton({ note }: { note: FragmentRef<typeof noteShareFragment> }) {
    const { data: value } = useFragment(note);
    const { reportError } = useWorkspace();
    if (!value || value.kind !== "note") return null;
    return (
        <IconButton
            label={typeof navigator.share === "function" ? "Share note" : "Copy note"}
            onClick={() =>
                void shareNote(value).catch((cause) => {
                    if (!(cause instanceof DOMException && cause.name === "AbortError"))
                        reportError(textError(cause));
                })
            }
        >
            <Share size={18} />
        </IconButton>
    );
}

export function ShareMenuItem({
    Parts,
    note,
}: {
    Parts: typeof Menu | typeof ContextMenu;
    note: FragmentRef<typeof noteShareFragment>;
}) {
    const { data: value } = useFragment(note);
    const { reportError } = useWorkspace();
    if (!value) return null;
    return (
        <Parts.Item
            className="menu-item"
            onClick={() =>
                void shareNote(value).catch((cause) => {
                    if (!(cause instanceof DOMException && cause.name === "AbortError"))
                        reportError(textError(cause));
                })
            }
        >
            <Share />
            {typeof navigator !== "undefined" && typeof navigator.share === "function"
                ? "Share note…"
                : "Copy note"}
        </Parts.Item>
    );
}
