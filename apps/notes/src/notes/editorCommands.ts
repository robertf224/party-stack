import { Bold, Braces, Code2, Heading2, Italic, List, ListTodo, Paperclip, Quote } from "lucide-react";
import type { Editor } from "@tiptap/react";

export type EditorCommand = {
    title: string;
    keywords: string;
    icon: typeof Bold;
    run: (editor: Editor) => void;
};
export function editorCommands(attach: () => void): EditorCommand[] {
    const commands: EditorCommand[] = [
        {
            title: "Code block",
            keywords: "code plain snippet",
            icon: Code2,
            run: (editor) => {
                editor.chain().focus().setCodeBlock({ language: "plaintext" }).run();
            },
        },
        {
            title: "Quote",
            keywords: "blockquote quote",
            icon: Quote,
            run: (editor) => {
                editor.chain().focus().toggleBlockquote().run();
            },
        },
        {
            title: "Heading",
            keywords: "heading h2",
            icon: Heading2,
            run: (editor) => {
                editor.chain().focus().toggleHeading({ level: 2 }).run();
            },
        },
        {
            title: "Bold",
            keywords: "bold strong",
            icon: Bold,
            run: (editor) => {
                editor.chain().focus().toggleBold().run();
            },
        },
        {
            title: "Italic",
            keywords: "italic emphasis",
            icon: Italic,
            run: (editor) => {
                editor.chain().focus().toggleItalic().run();
            },
        },
        {
            title: "Bulleted list",
            keywords: "bullet list unordered",
            icon: List,
            run: (editor) => {
                editor.chain().focus().toggleBulletList().run();
            },
        },
        {
            title: "Checklist",
            keywords: "task todo checklist",
            icon: ListTodo,
            run: (editor) => {
                editor.chain().focus().toggleTaskList().run();
            },
        },
        {
            title: "Attachment",
            keywords: "file image photo attachment upload",
            icon: Paperclip,
            run: () => attach(),
        },
        ...(
            [
                ["TypeScript", "typescript", "ts"],
                ["Rust", "rust", "rs"],
                ["HTML", "html", "html"],
                ["JSON", "json", "json"],
            ] as const
        ).map(([title, language, keyword]) => ({
            title,
            keywords: `code snippet ${keyword}`,
            icon: Braces,
            run: (editor: Editor) => {
                editor.chain().focus().setCodeBlock({ language }).run();
            },
        })),
    ];
    const order = [
        "Heading",
        "Bulleted list",
        "Checklist",
        "Quote",
        "Bold",
        "Italic",
        "Attachment",
        "Code block",
        "TypeScript",
        "Rust",
        "HTML",
        "JSON",
    ];
    return commands.sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
}
export function runEditorCommand(editor: Editor, command: EditorCommand) {
    command.run(editor);
    editor.view.focus();
}
