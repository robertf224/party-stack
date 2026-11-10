import { defineFragment, useFragment, type FragmentRef } from "@party-stack/ontology-react";
import { Folder } from "lucide-react";
import { objects } from "../ontology/generated/collections";

export const folderTitleFragment = defineFragment(objects.Notebook, (folder) => ({
    name: folder.name,
    color: folder.color,
}));

export function FolderTitle({ folder }: { folder: FragmentRef<typeof folderTitleFragment> }) {
    const { data: value } = useFragment(folder);
    return (
        <>
            <Folder className="view-icon" style={{ color: value?.color }} />
            <span>{value?.name ?? "Notes"}</span>
        </>
    );
}
