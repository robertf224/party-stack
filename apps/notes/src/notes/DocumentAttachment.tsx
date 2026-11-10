import { useAttachmentMetadata, useAttachmentUrl } from "@party-stack/ontology-react";
import { eq } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { CatchBoundary } from "@tanstack/react-router";
import Image from "@tiptap/extension-image";
import { NodeSelection } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from "@tiptap/react";
import { Download, FileText } from "lucide-react";
import { Suspense } from "react";
import { objects } from "../ontology/generated/collections";

export const AttachmentImage = Image.extend({
    draggable: false,
    addKeyboardShortcuts() {
        return {
            Enter: () => {
                const selection = this.editor.state.selection;
                if (
                    !this.editor.isEditable ||
                    !(selection instanceof NodeSelection) ||
                    selection.node.type.name !== this.name
                )
                    return false;
                return paragraphAfterAttachment(this.editor, selection.to);
            },
        };
    },
    addNodeView() {
        return ReactNodeViewRenderer(DocumentAttachment);
    },
});
function paragraphAfterAttachment(editor: Editor, position: number) {
    return editor
        .chain()
        .focus()
        .insertContentAt(position, { type: "paragraph" })
        .setTextSelection(position + 1)
        .run();
}
function DocumentAttachment({ node, editor, getPos }: NodeViewProps) {
    const src = String(node.attrs.src ?? "");
    return (
        <NodeViewWrapper
            className="document-attachment"
            data-attachment-id={src.startsWith("attachment:") ? src.slice(11) : ""}
            contentEditable={false}
        >
            <CatchBoundary
                getResetKey={() => src}
                errorComponent={() => (
                    <span className="attachment-placeholder">Couldn’t open attachment</span>
                )}
            >
                <Suspense
                    fallback={<span className="attachment-placeholder" aria-label="Opening attachment" />}
                >
                    <AttachmentContent node={node} editor={editor} getPos={getPos} />
                </Suspense>
            </CatchBoundary>
        </NodeViewWrapper>
    );
}
function AttachmentContent({ node, editor, getPos }: Pick<NodeViewProps, "node" | "editor" | "getPos">) {
    const src = String(node.attrs.src ?? "");
    const id = src.startsWith("attachment:") ? src.slice(11) : "";
    const { data } = useLiveSuspenseQuery((q) =>
        q
            .from({ item: objects.NoteAttachment })
            .where(({ item }) => eq(item.id, id))
            .select(({ item }) => ({ file: item.file }))
            .findOne()
    );
    const url = useAttachmentUrl(data?.file, { enabled: !!id });
    const metadata = useAttachmentMetadata(data?.file, {
        select: ["name", "type", "size"],
        enabled: !!id,
    });
    const image = !id || metadata?.type?.startsWith("image/");
    return (
        <>
            {image ? (
                <img
                    src={id ? url : src}
                    alt={String(node.attrs.alt ?? metadata?.name ?? "Attachment")}
                    draggable={false}
                />
            ) : (
                <div
                    className="document-file"
                    tabIndex={0}
                    role="group"
                    aria-label={`Attachment: ${metadata?.name ?? node.attrs.alt ?? "File"}`}
                    onFocus={(event) => {
                        if (event.target !== event.currentTarget) return;
                        const position = getPos();
                        if (position !== undefined) editor.commands.setNodeSelection(position);
                    }}
                    onKeyDown={(event) => {
                        if (
                            event.target !== event.currentTarget ||
                            event.key !== "Enter" ||
                            !editor.isEditable
                        )
                            return;
                        const position = getPos();
                        if (position === undefined) return;
                        event.preventDefault();
                        event.stopPropagation();
                        paragraphAfterAttachment(editor, position + node.nodeSize);
                    }}
                >
                    <FileText size={23} />
                    <span>
                        {metadata?.name ?? node.attrs.alt ?? "Attachment"}
                        <small>
                            {metadata?.size !== undefined
                                ? `${Math.max(1, Math.round(metadata.size / 1024))} KB`
                                : undefined}
                        </small>
                    </span>
                    <a
                        href={url}
                        download={metadata?.name}
                        draggable={false}
                        className="icon-button"
                        aria-label={`Download ${metadata?.name ?? node.attrs.alt ?? "attachment"}`}
                        aria-disabled={!url}
                    >
                        <Download size={16} />
                    </a>
                </div>
            )}
        </>
    );
}
