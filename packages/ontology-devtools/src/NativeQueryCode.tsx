import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import { useMemo } from "react";

const highlighter = hljs.newInstance();
highlighter.registerLanguage("json", json);
highlighter.registerLanguage("sql", sql);
const aliases = new Map([
    ["json", "json"],
    ["sql", "sql"],
    ["postgres", "sql"],
    ["postgresql", "sql"],
    ["sqlite", "sql"],
]);

export function NativeQueryCode({ language, text }: { language: string; text: string }) {
    const grammar = aliases.get(language.toLowerCase());
    const highlighted = useMemo(
        () =>
            grammar
                ? highlighter.highlight(text, { language: grammar, ignoreIllegals: true }).value
                : undefined,
        [grammar, text]
    );
    return (
        <pre className="ps-native-code" aria-label="Native query code">
            {highlighted === undefined ? (
                <code>{text}</code>
            ) : (
                // Highlight.js escapes source text before adding its own token spans.
                <code className={`language-${grammar}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
            )}
        </pre>
    );
}
