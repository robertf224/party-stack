import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { QueryOwners } from "./QueryOwners.js";
import type { DemandOwner } from "./attribution/registry.js";

const owner = (id: string, name: string, source = `${name}.tsx`): DemandOwner => ({ id, name, source });

test("query headers name components and group mounted instances", () => {
    const html = renderToStaticMarkup(
        <QueryOwners owners={[owner("1", "IssueList"), owner("2", "IssueList"), owner("3", "Sidebar")]} />
    );
    expect(html).toContain('aria-label="3 components"');
    expect(html).toContain("IssueList ×2");
    expect(html).toContain("Sidebar");
    expect(html).not.toContain("other component");
    expect(renderToStaticMarkup(<QueryOwners owners={[]} />)).toBe("");
});

test("query headers name at most three component types and count remaining instances", () => {
    const owners = [owner("1", "IssueList"), owner("2", "Sidebar"), owner("3", "IssueCounter")];
    for (let index = 0; index < 10; index++) owners.push(owner(`other-${index}`, "IssueDetail"));
    const html = renderToStaticMarkup(<QueryOwners owners={owners} />);
    expect(html.match(/class="ps-query-owner-name"/g)).toHaveLength(3);
    expect(html).toContain("and 10 other components");
    expect(html).not.toContain("IssueDetail");
    expect(renderToStaticMarkup(<QueryOwners owners={owners.slice(0, 4)} />)).toContain(
        "and 1 other component"
    );
});

test("components with the same name in different files remain distinct", () => {
    const html = renderToStaticMarkup(
        <QueryOwners
            owners={[owner("1", "List", "issues/List.tsx"), owner("2", "List", "projects/List.tsx")]}
        />
    );
    expect(html.match(/class="ps-query-owner-name"/g)).toHaveLength(2);
    expect(html).not.toContain("×2");
});
