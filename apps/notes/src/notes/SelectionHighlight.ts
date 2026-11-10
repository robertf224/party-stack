import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Extension } from "@tiptap/react";

/** Browser text highlighting skips non-editable node views. Paint those blocks
 * from ProseMirror's actual selection, without replacing its selection behavior. */
export const SelectionHighlight = Extension.create({
    name: "selectionHighlight",
    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    decorations(state) {
                        if (state.selection.empty) return DecorationSet.empty;
                        const decorations: Decoration[] = [];
                        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
                            if (node.type.name === "image" || node.type.name === "codeBlock")
                                decorations.push(
                                    Decoration.node(pos, pos + node.nodeSize, { class: "block-in-selection" })
                                );
                        });
                        return DecorationSet.create(state.doc, decorations);
                    },
                },
            }),
        ];
    },
});
