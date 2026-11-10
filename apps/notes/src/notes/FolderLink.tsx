import { defineFragment, useFragment, type FragmentRef } from "@party-stack/ontology-react";
import { Folder } from "lucide-react";
import { objects } from "../ontology/generated/collections";
import { FolderMenu, folderMenuFragment } from "./FolderMenu";
import type { ReactElement, ReactNode } from "react";

export const folderLinkFragment = defineFragment(objects.Notebook, (folder) => ({
    id: folder.id,
    name: folder.name,
    color: folder.color,
    menu: folderMenuFragment.include(folder),
}));

export function FolderLink({
    folder,
    nav,
    trailing,
}: {
    folder: FragmentRef<typeof folderLinkFragment>;
    nav: (id: string, name: string, icon: ReactNode, trailing?: ReactNode) => ReactElement;
    trailing?: ReactNode;
}) {
    const { data: value } = useFragment(folder);
    return value ? (
        <FolderMenu
            folder={value.menu}
            contextMenu
            trigger={nav(
                `folder:${value.id}`,
                value.name,
                <Folder style={{ color: value.color }} />,
                trailing
            )}
        />
    ) : null;
}
