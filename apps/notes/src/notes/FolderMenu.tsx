import { ContextMenu } from "@base-ui/react/context-menu";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import {
    defineFragment,
    useFragment,
    useOntology,
    type FragmentData,
    type FragmentRef,
} from "@party-stack/ontology-react";
import { useNavigate } from "@tanstack/react-router";
import { Pencil, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { objects } from "../ontology/generated/collections";
import { FolderForm } from "./FolderForm";
import { collectionLocation } from "./navigation";
import { DialogBackdrop, DialogHeader, GlassButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";

export const folderMenuFragment = defineFragment(objects.Notebook, (folder) => ({
    id: folder.id,
    name: folder.name,
    color: folder.color,
}));
export type Folder = FragmentData<typeof folderMenuFragment>;
export function FolderMenu({
    folder,
    trigger,
    contextMenu = false,
}: {
    folder: FragmentRef<typeof folderMenuFragment>;
    trigger: ReactElement;
    contextMenu?: boolean;
}) {
    const { data: value } = useFragment(folder);
    return value ? <FolderMenuContent folder={value} trigger={trigger} contextMenu={contextMenu} /> : null;
}

function FolderMenuContent({
    folder,
    trigger,
    contextMenu,
}: {
    folder: Folder;
    trigger: ReactElement;
    contextMenu: boolean;
}) {
    const ontology = useOntology<NotesOntology>();
    const { view, reportError, cancelEditorFocus } = useWorkspace();
    const navigate = useNavigate();
    const [dialog, setDialog] = useState<"edit" | "delete">();
    const Parts = contextMenu ? ContextMenu : Menu;
    return (
        <>
            <Parts.Root>
                <Parts.Trigger render={trigger} />
                <Parts.Portal>
                    <Parts.Positioner className="menu-positioner" sideOffset={6} align="start">
                        <Parts.Popup className="glass-menu">
                            <Parts.Item className="menu-item" onClick={() => setDialog("edit")}>
                                <Pencil />
                                Edit folder…
                            </Parts.Item>
                            <Parts.Separator className="menu-separator" />
                            <Parts.Item className="menu-item" onClick={() => setDialog("delete")}>
                                <Trash2 />
                                Delete folder…
                            </Parts.Item>
                        </Parts.Popup>
                    </Parts.Positioner>
                </Parts.Portal>
            </Parts.Root>
            <Dialog.Root
                open={dialog === "edit"}
                onOpenChange={(open) => {
                    if (!open) setDialog(undefined);
                }}
            >
                <Dialog.Portal>
                    <DialogBackdrop />
                    <Dialog.Popup className="glass-dialog folder-dialog">
                        <DialogHeader title="Edit folder" closeLabel="Close edit folder" />
                        <FolderForm folder={folder} close={() => setDialog(undefined)} />
                    </Dialog.Popup>
                </Dialog.Portal>
            </Dialog.Root>
            <Dialog.Root
                open={dialog === "delete"}
                onOpenChange={(open) => {
                    if (!open) setDialog(undefined);
                }}
            >
                <Dialog.Portal>
                    <DialogBackdrop />
                    <Dialog.Popup className="glass-dialog folder-dialog">
                        <DialogHeader title="Delete folder?" closeLabel="Close delete folder" />
                        <Dialog.Description className="folder-delete-description">
                            “{folder.name}” will be deleted. Its notes will move to Recently Deleted.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close render={<GlassButton>Cancel</GlassButton>} />
                            <GlassButton
                                icon={<Trash2 size={17} />}
                                onClick={() => {
                                    cancelEditorFocus();
                                    void ontology.actions
                                        .deleteNotebook({ notebook: folder.id })
                                        .catch((cause) => reportError(textError(cause)));
                                    setDialog(undefined);
                                    if (view === `folder:${folder.id}`)
                                        void navigate(collectionLocation("all"));
                                }}
                            >
                                Delete folder
                            </GlassButton>
                        </div>
                    </Dialog.Popup>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
}
