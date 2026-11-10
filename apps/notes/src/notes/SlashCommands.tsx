import { Button } from "@base-ui/react/button";
import { Extension, ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { editorCommands, runEditorCommand, type EditorCommand } from "./editorCommands";

type Command = EditorCommand;
type MenuProps = SuggestionProps<Command, Command> & {
    ref?: Ref<{ onKeyDown(event: KeyboardEvent): boolean }>;
};
function CommandMenu({ items, command, ref }: MenuProps) {
    const [selected, setSelected] = useState(0);
    const element = useRef<HTMLDivElement>(null);
    useEffect(() => {
        element.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
    }, [selected]);
    useEffect(() => setSelected(0), [items]);
    useImperativeHandle(
        ref,
        () => ({
            onKeyDown(event) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    setSelected(
                        (index) =>
                            (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                            Math.max(1, items.length)
                    );
                    return true;
                }
                if (event.key === "Enter" && items[selected]) {
                    command(items[selected]);
                    return true;
                }
                return false;
            },
        }),
        [items, selected, command]
    );
    return (
        <div ref={element} className="glass-menu slash-menu" role="listbox" aria-label="Insert into note">
            {items.map((item, index) => (
                <Button
                    key={item.title}
                    className="menu-item"
                    role="option"
                    aria-selected={index === selected}
                    data-highlighted={index === selected || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setSelected(index)}
                    onClick={() => command(item)}
                >
                    <item.icon size={16} />
                    <span>{item.title}</span>
                </Button>
            ))}
            {!items.length && <div className="slash-empty">No commands</div>}
        </div>
    );
}
export const SlashCommands = Extension.create<{ attach: () => void }>({
    name: "slashCommands",
    addOptions: () => ({ attach: () => {} }),
    addProseMirrorPlugins() {
        const commands = editorCommands(this.options.attach);
        return [
            Suggestion<Command, Command>({
                editor: this.editor,
                char: "/",
                startOfLine: true,
                allow: ({ editor }) => editor.isEditable && !editor.isActive("codeBlock"),
                items: ({ query }) =>
                    commands.filter((item) =>
                        `${item.title} ${item.keywords}`.toLowerCase().includes(query.toLowerCase())
                    ),
                command: ({ editor, range, props }) => {
                    editor.chain().focus().deleteRange(range).run();
                    runEditorCommand(editor, props);
                },
                render: () => {
                    let renderer: ReactRenderer<{ onKeyDown(event: KeyboardEvent): boolean }> | undefined;
                    let unmount: (() => void) | undefined;
                    return {
                        onStart(props) {
                            renderer = new ReactRenderer(CommandMenu, { props, editor: props.editor });
                            unmount = props.mount(renderer.element as HTMLElement);
                        },
                        onUpdate(props) {
                            renderer?.updateProps(props);
                        },
                        onKeyDown({ event }) {
                            return renderer?.ref?.onKeyDown(event) ?? false;
                        },
                        onExit() {
                            unmount?.();
                            renderer?.destroy();
                        },
                    };
                },
            }),
        ];
    },
});
