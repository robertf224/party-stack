import { Dialog } from "@base-ui/react/dialog";
import { FolderPlus } from "lucide-react";
import { useRef, useState } from "react";
import { FolderForm } from "./FolderForm";
import { DialogBackdrop, DialogHeader, IconButton } from "./ui";

export function NewFolderDialog() {
    const [open, setOpen] = useState(false);
    const nameInput = useRef<HTMLInputElement>(null);
    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger
                render={
                    <IconButton label="New folder">
                        <FolderPlus size={18} />
                    </IconButton>
                }
            />
            <Dialog.Portal>
                <DialogBackdrop />
                <Dialog.Popup className="glass-dialog folder-dialog" initialFocus={nameInput}>
                    <DialogHeader title="New folder" closeLabel="Close new folder" />
                    <FolderForm nameInput={nameInput} close={() => setOpen(false)} />
                </Dialog.Popup>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
