import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { NativeQueryCode } from "./NativeQueryCode.js";

const render = (language: string, text: string) =>
    renderToStaticMarkup(createElement(NativeQueryCode, { language, text }));

test("native JSON and SQL queries use language-specific token highlighting", () => {
    const json = render("json", '{\n  "value": "urgent", "limit": 2, "active": true\n}');
    expect(json).toContain('class="hljs-attr"');
    expect(json).toContain('class="hljs-string"');
    expect(json).toContain('class="hljs-number"');
    expect(json).toContain('class="hljs-literal"');
    const sql = render("SQLITE", "SELECT * FROM notes WHERE title = 'urgent' LIMIT 2");
    expect(sql).toContain('class="language-sql"');
    expect(sql).toContain('class="hljs-keyword"');
    expect(sql).toContain('class="hljs-string"');
});

test("highlighting preserves source whitespace and treats embedded HTML as text", () => {
    const text = '{\n  "html": "</code><script>alert(1)</script>"\n}';
    const html = render("json", text);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('\n  <span class="hljs-attr">');
});

test("unknown formats remain escaped plain text without guessing a grammar", () => {
    for (const language of ["custom-provider-format", "__proto__"]) {
        const html = render(language, "<script>SELECT * FROM notes</script>");
        expect(html).toContain("&lt;script&gt;SELECT * FROM notes&lt;/script&gt;");
        expect(html).not.toContain("hljs-");
    }
});
