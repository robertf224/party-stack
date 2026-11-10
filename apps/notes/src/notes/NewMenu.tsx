import { Menu } from "@base-ui/react/menu";
import { FileText, KeyRound, LockKeyhole, SquarePen } from "lucide-react";
import { useRef } from "react";
import { IconButton } from "./ui";
import type { Note } from "../ontology/generated/types";

export function NewMenu({ create }: { create: (kind: Note["kind"]) => Promise<void> }) {
    const creating = useRef(false);
    const onOpenChange = (open: boolean) => {
        if (open) {
            creating.current = false;
            // Warm the editor module on intent without acquiring note data.
            void import("./NoteEditor").catch(() => undefined);
        }
    };
    return (
        <Menu.Root onOpenChange={onOpenChange}>
            <Menu.Trigger
                render={
                    <IconButton label="New note" aria-keyshortcuts="Shift+N">
                        <SquarePen size={18} />
                    </IconButton>
                }
            />
            <Menu.Portal>
                <Menu.Positioner sideOffset={8} align="start" className="menu-positioner">
                    <Menu.Popup className="glass-menu" finalFocus={() => !creating.current}>
                        {(
                            [
                                ["note", "Note", FileText],
                                ["secure", "Secure note", LockKeyhole],
                                ["login", "Login", KeyRound],
                            ] as const
                        ).map(([kind, title, Icon]) => (
                            <Menu.Item
                                className="menu-item"
                                key={kind}
                                onClick={() => {
                                    creating.current = true;
                                    void create(kind);
                                }}
                            >
                                <Icon />
                                {title}
                            </Menu.Item>
                        ))}
                    </Menu.Popup>
                </Menu.Positioner>
            </Menu.Portal>
        </Menu.Root>
    );
}
