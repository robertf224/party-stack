import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import json from "highlight.js/lib/languages/json";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import { createLowlight } from "lowlight";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CompactSelect, IconButton } from "./ui";

const lowlight = createLowlight({ typescript, rust, xml, json });
export const codeLanguages = [
    { value: "plaintext", label: "Plain text" },
    { value: "typescript", label: "TypeScript" },
    { value: "rust", label: "Rust" },
    { value: "html", label: "HTML" },
    { value: "json", label: "JSON" },
];
export const HighlightedCode = CodeBlockLowlight.extend({
    addNodeView() {
        return ReactNodeViewRenderer(CodeBlockView);
    },
}).configure({ lowlight, defaultLanguage: "plaintext", enableTabIndentation: true, tabSize: 2 });
function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    return (
        <NodeViewWrapper className="code-block">
            <div className="code-block-heading" contentEditable={false}>
                <CompactSelect
                    label="Code language"
                    value={node.attrs.language === "xml" ? "html" : (node.attrs.language ?? "plaintext")}
                    items={codeLanguages}
                    disabled={!editor.isEditable}
                    onChange={(language) => updateAttributes({ language })}
                />
                <IconButton
                    label={copied ? "Copied code" : "Copy code"}
                    onClick={() => {
                        void navigator.clipboard.writeText(node.textContent).then(() => {
                            setCopied(true);
                            clearTimeout(timer.current);
                            timer.current = setTimeout(() => setCopied(false), 1500);
                        });
                    }}
                >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
            </div>
            <pre>
                <NodeViewContent<"code"> as="code" />
            </pre>
        </NodeViewWrapper>
    );
}
