import { Menu } from "@base-ui/react/menu";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { editorCommands, runEditorCommand } from "./editorCommands";
import { IconButton } from "./ui";
import type { Editor } from "@tiptap/react";

export function EditorInsertMenu({ editor, attach }: { editor: Editor; attach: () => void }) {
    const commands = useMemo(() => editorCommands(attach), [attach]);
    return (
        <Menu.Root>
            <Menu.Trigger
                render={
                    <IconButton label="Insert into note">
                        <Plus size={21} />
                    </IconButton>
                }
            />
            <Menu.Portal>
                <Menu.Positioner className="menu-positioner" sideOffset={7} align="start">
                    <Menu.Popup
                        className="glass-menu insert-menu"
                        finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
                    >
                        {commands.map((command) => (
                            <Menu.Item
                                key={command.title}
                                className="menu-item"
                                onClick={() => runEditorCommand(editor, command)}
                            >
                                <command.icon size={17} />
                                {command.title}
                            </Menu.Item>
                        ))}
                    </Menu.Popup>
                </Menu.Positioner>
            </Menu.Portal>
        </Menu.Root>
    );
}
