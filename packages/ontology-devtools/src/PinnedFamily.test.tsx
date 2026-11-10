import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { PinnedFamily, groupPinDownloads } from "./PinnedFamily.js";
import type { PinRecord } from "@party-stack/ontology";

const pin = (id: string, definition = "v1"): PinRecord => ({
    id,
    name: "folders",
    definition,
    query: { select: [] },
    inputs: { folderId: id },
    attachments: "all",
    generation: id,
    ready: id === "a",
});
test("a family shows one query per revision and separate input/status rows", () => {
    const family = groupPinDownloads([pin("a"), pin("b"), pin("c", "v2")])[0]!;
    expect(family.revisions.size).toBe(2);
    expect(family.revisions.get("v1")).toHaveLength(2);
    const html = renderToStaticMarkup(
        createElement(PinnedFamily, {
            family,
            ir: { types: [], objectTypes: [], actionTypes: [], linkTypes: [], queryFunctionTypes: [] },
            remove: async () => {},
        })
    );
    expect(html.match(/class="ps-query-document"/g)).toHaveLength(2);
    expect(html.match(/data-pin-id=/g)).toHaveLength(3);
    expect(html.match(/<h2>folders<\/h2>/g)).toHaveLength(1);
    expect(html).toContain("Available offline");
    expect(html).toContain("Downloading");
    expect(html).toContain("folderId");
    expect(html).toContain("Includes attachment bytes");
});
