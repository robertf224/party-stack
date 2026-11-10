import { defineFragment, useFragment, useOntology, type FragmentRef } from "@party-stack/ontology-react";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code2, Italic, List, ListTodo } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { objects } from "../ontology/generated/collections";
import { HighlightedCode } from "./CodeBlock";
import { noteDocument, readNoteDocument } from "./document";
import { AttachmentImage } from "./DocumentAttachment";
import { EditorInsertMenu } from "./EditorInsertMenu";
import { SelectionHighlight } from "./SelectionHighlight";
import { SlashCommands } from "./SlashCommands";
import { IconButton, textError } from "./ui";
import { useWorkspace } from "./workspaceContext";
import type { NotesOntology } from "../ontology/generated/types";

export const richEditorFragment = defineFragment(objects.Note, (note) => ({
    id: note.id,
    title: note.title,
    body: note.bodyMarkdown,
    trashed: note.trashed,
}));

export function RichEditor({ note }: { note: FragmentRef<typeof richEditorFragment> }) {
    const { data: value } = useFragment(note);
    return value ? (
        <RichEditorContent
            noteId={value.id}
            title={value.title === "Untitled" && !value.body ? "" : value.title}
            body={value.body}
            readOnly={value.trashed}
        />
    ) : null;
}

function RichEditorContent({
    noteId,
    title,
    body,
    readOnly,
}: {
    noteId: string;
    title: string;
    body: string;
    readOnly: boolean;
}) {
    const ontology = useOntology<NotesOntology>();
    const { claimEditorFocus, reportError } = useWorkspace();
    const save = useCallback(
        async (title: string, bodyMarkdown: string) => {
            await ontology.actions.updateNote({ note: noteId, title, bodyMarkdown });
        },
        [ontology, noteId]
    );
    // Assets remain owned by the note while its editor history can reference them.
    const saveRef = useRef(save);
    const errorRef = useRef(reportError);
    useEffect(() => {
        saveRef.current = save;
        errorRef.current = reportError;
    }, [save, reportError]);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latest = useRef({ title, body });
    const dirty = useRef(false);
    const [pendingSaves, setPendingSaves] = useState(0);
    const fileInput = useRef<HTMLInputElement>(null);
    const uploadRef = useRef<(files: File[], position: number) => void>(() => {});
    function flush() {
        clearTimeout(timer.current);
        timer.current = undefined;
        if (!dirty.current) return;
        dirty.current = false;
        setPendingSaves((count) => count + 1);
        void saveRef
            .current(latest.current.title, latest.current.body)
            .catch((cause) => errorRef.current(textError(cause)))
            .finally(() => setPendingSaves((count) => count - 1));
    }
    const editor = useEditor({
        extensions: [
            StarterKit.configure({ codeBlock: false }),
            HighlightedCode,
            SelectionHighlight,
            SlashCommands.configure({ attach: () => fileInput.current?.click() }),
            Markdown,
            TaskList,
            TaskItem.configure({ nested: true }),
            AttachmentImage,
        ],
        content: "",
        contentType: "markdown",
        immediatelyRender: false,
        editable: !readOnly,
        editorProps: {
            attributes: {
                class: "markdown-editor",
                "aria-label": "Note content",
                role: "textbox",
                "aria-multiline": "true",
            },
            handleDrop(view, event, _slice, moved) {
                const files = Array.from(event.dataTransfer?.files ?? []);
                if (moved || !files.length || readOnly) return false;
                event.preventDefault();
                uploadRef.current(
                    files,
                    view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
                        view.state.selection.from
                );
                return true;
            },
            handlePaste(view, event) {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (!files.length || readOnly) return false;
                event.preventDefault();
                uploadRef.current(files, view.state.selection.from);
                return true;
            },
        },
        onCreate: ({ editor }) => {
            editor.commands.setContent(noteDocument(editor, title, body), { emitUpdate: false });
            if (claimEditorFocus(noteId)) editor.commands.focus("start");
        },
        onUpdate: ({ editor }) => {
            latest.current = readNoteDocument(editor);
            dirty.current = true;
            clearTimeout(timer.current);
            timer.current = setTimeout(flush, 450);
        },
        onBlur: flush,
    });
    useEffect(() => {
        uploadRef.current = (files, position) => {
            void (async () => {
                for (const file of files) {
                    const id = crypto.randomUUID();
                    const { attachment } = await ontology.attachments.create(file, {
                        target: { kind: "actionParameter", actionType: "addAttachment", parameter: "file" },
                    });
                    const parameters = {
                        id,
                        noteId,
                        file: attachment,
                    } satisfies NotesOntology["actionTypes"]["addAttachment"]["parameters"];
                    const action = await ontology.outbox.enqueue({
                        actionTypeName: "addAttachment",
                        parameters,
                    });
                    void action.completed.catch((cause) => errorRef.current(textError(cause)));
                    await action.accepted;
                    if (!editor || editor.isDestroyed) {
                        void ontology.actions
                            .removeAttachment({ attachment: id })
                            .catch((cause) => errorRef.current(textError(cause)));
                        return;
                    }
                    editor
                        .chain()
                        .focus()
                        .insertContentAt(Math.min(position, editor.state.doc.content.size), {
                            type: "image",
                            attrs: { src: `attachment:${id}`, alt: file.name },
                        })
                        .run();
                    position = editor.state.selection.to;
                }
            })().catch((cause) => errorRef.current(textError(cause)));
        };
    }, [editor, ontology, noteId]);
    useEffect(() => {
        if (!editor || editor.isDestroyed || dirty.current || pendingSaves) return;
        const current = readNoteDocument(editor);
        if (current.title === title && current.body === body) return;
        const { from, to } = editor.state.selection;
        editor
            .chain()
            .setMeta("addToHistory", false)
            .setContent(noteDocument(editor, title, body), { emitUpdate: false })
            .run();
        const end = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
    }, [editor, title, body, pendingSaves]);
    useEffect(() => {
        editor?.setEditable(!readOnly, false);
    }, [editor, readOnly]);
    useEffect(() => () => flush(), []);
    const active = useEditorState({
        editor,
        selector: ({ editor }) => ({
            bold: editor?.isActive("bold"),
            italic: editor?.isActive("italic"),
            list: editor?.isActive("bulletList"),
            tasks: editor?.isActive("taskList"),
        }),
    });
    const { formatTarget, insertTarget } = useWorkspace();
    const toolbar = (
        <div
            className="format-toolbar"
            role="toolbar"
            aria-label="Text formatting"
            onMouseDown={(event) => event.preventDefault()}
        >
            <IconButton
                label="Bold"
                active={active?.bold}
                onClick={() => editor?.chain().focus().toggleBold().run()}
            >
                <Bold size={16} />
            </IconButton>
            <IconButton
                label="Italic"
                active={active?.italic}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
                <Italic size={16} />
            </IconButton>
            <span className="toolbar-divider" />
            <IconButton
                label="Bulleted list"
                active={active?.list}
                onClick={() => {
                    if (editor) {
                        editor.chain().focus().toggleBulletList().run();
                    }
                }}
            >
                <List size={18} />
            </IconButton>
            <IconButton
                label="Checklist"
                active={active?.tasks}
                onClick={() => {
                    if (editor) {
                        editor.chain().focus().toggleTaskList().run();
                        editor.view.focus();
                    }
                }}
            >
                <ListTodo size={18} />
            </IconButton>
            <IconButton
                label="Code block"
                onClick={() => {
                    if (editor) {
                        editor.chain().focus().toggleCodeBlock().run();
                    }
                }}
            >
                <Code2 size={16} />
            </IconButton>
        </div>
    );
    return (
        <>
            {!readOnly && (
                <>
                    {formatTarget &&
                        createPortal(<div className="desktop-format">{toolbar}</div>, formatTarget)}
                    {insertTarget &&
                        editor &&
                        createPortal(
                            <EditorInsertMenu editor={editor} attach={() => fileInput.current?.click()} />,
                            insertTarget
                        )}
                </>
            )}
            <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label="Choose attachments"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    if (files.length && editor) uploadRef.current(files, editor.state.selection.from);
                    event.target.value = "";
                }}
            />
            <EditorContent editor={editor} />
        </>
    );
}
