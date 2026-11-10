import { Folder, Trash2 } from "lucide-react";
import { FolderTitle, folderTitleFragment } from "./FolderTitle";
import type { FragmentRef } from "@party-stack/ontology-react";

export function ListTitle({
    view,
    folder,
}: {
    view: string;
    folder?: FragmentRef<typeof folderTitleFragment>;
}) {
    if (view.startsWith("folder:") && folder) return <FolderTitle folder={folder} />;
    const Icon = view === "trash" ? Trash2 : Folder;
    return (
        <>
            <Icon className="view-icon" style={view === "trash" ? { color: "var(--muted)" } : undefined} />
            <span>
                {view === "trash" ? "Recently deleted" : view.startsWith("folder:") ? "Folder" : "Notes"}
            </span>
        </>
    );
}
