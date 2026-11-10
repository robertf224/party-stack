import type { Editor, JSONContent } from "@tiptap/react";

export function noteDocument(editor: Editor, title: string, body: string): JSONContent {
    const markdown = editor.markdown;
    if (!markdown) throw new Error("Markdown support is not installed.");
    if (body) return markdown.parse(body);
    // A newly created note can supply initial text through its list label.
    return {
        type: "doc",
        content: [{ type: "paragraph", content: title ? [{ type: "text", text: title }] : [] }],
    };
}

/** The title is derived metadata; the complete formatted document stays in the body. */
export function readNoteDocument(editor: Editor) {
    const markdown = editor.markdown;
    if (!markdown) throw new Error("Markdown support is not installed.");
    return {
        title: editor.state.doc
            .textBetween(0, editor.state.doc.content.size, "\n", "\n")
            .split("\n")[0]!
            .trim(),
        body: markdown.serialize(editor.getJSON()),
    };
}
