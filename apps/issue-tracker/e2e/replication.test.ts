import { env } from "node:process";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

// Start the app with vp run @party-stack/issue-tracker#dev and pass its printed worktree URL.
const url = env.ISSUE_TRACKER_TEST_URL;
let browser: Browser;
beforeAll(async () => {
    if (url) browser = await chromium.launch();
});
afterAll(async () => {
    await browser?.close();
});
const visible = async (page: Page, role: Parameters<Page["getByRole"]>[0], name: string | RegExp) => {
    await expect.poll(() => page.getByRole(role, { name }).isVisible()).toBe(true);
};

test.skipIf(!url)(
    "offline actions survive initiating-tab closure and settle through one shared owner",
    async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const errors: string[] = [];
        const fallback: string[] = [];
        context.on("page", (page) => {
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
                if (message.text().includes("using the in-process owner")) fallback.push(message.text());
            });
        });
        const first = await context.newPage();
        const title = `Shared-owner acceptance ${crypto.randomUUID().slice(0, 8)}`;
        const label = `label-${crypto.randomUUID().slice(0, 8)}`;
        try {
            await first.goto(url!);
            await visible(first, "heading", "Connect profile");
            await first.getByRole("button", { name: "Connect", exact: true }).click();
            await visible(first, "button", "New issue");
            await first.getByRole("button", { name: "New issue" }).click();
            await first.getByLabel("Title", { exact: true }).fill(title);
            await first.getByLabel("Add issue label", { exact: true }).fill(label);
            await first.getByLabel("Add issue label", { exact: true }).press("Enter");
            await first.getByRole("button", { name: "Create issue", exact: true }).click();
            await first.getByPlaceholder("Search issues").fill(label);
            await visible(first, "button", new RegExp(title));
            await first.getByRole("button", { name: "Open TanStack Devtools" }).click();
            await first.getByRole("tab", { name: "Queries", exact: true }).click();
            const searchDemand = first
                .locator(".ps-query-card")
                .filter({ has: first.locator(".ps-query-component-target").filter({ hasText: label }) });
            await expect
                .poll(() => searchDemand.locator(".ps-query-component-target").innerText())
                .toContain("in");
            expect(await searchDemand.locator(".ps-query-execution").isVisible()).toBe(false);
            await searchDemand.locator(".ps-query-pushdown > summary").click();
            await expect
                .poll(() => searchDemand.locator(".ps-query-execution").innerText())
                .toContain("Tab replica");
            await expect
                .poll(() => searchDemand.locator(".ps-query-execution").innerText())
                .toContain("Satisfied by local coverage; no upstream request needed.");
            expect(
                await searchDemand.getByRole("heading", { name: "Coverage", exact: true }).isVisible()
            ).toBe(true);
            expect(await searchDemand.locator(".ps-query-execution").innerText()).toContain(
                "Complete collection; includes every matching row."
            );
            expect(await searchDemand.locator(".ps-query-execution").innerText()).toMatch(
                /Refreshed (through journal catch-up|by source change notifications)\./
            );
            expect((await searchDemand.locator(".ps-query-step h4").allTextContents()).slice(0, 2)).toEqual([
                "1Tab replica",
                "2Shared worker replica",
            ]);
            expect(await searchDemand.locator(".ps-query-step").count()).toBe(3);
            expect(await searchDemand.locator('[data-source-state="cached"]').innerText()).toContain(
                "Skipped · replica cache hit"
            );
            expect(await searchDemand.locator(".ps-query-path").count()).toBe(0);
            expect(await searchDemand.locator(".ps-query-component-target").innerText()).toContain(
                "Issue Labels"
            );
            expect(await searchDemand.locator(".ps-query-pushdown").getAttribute("open")).not.toBeNull();
            await first.getByPlaceholder("Search issues").fill(title);
            await first.getByRole("tab", { name: /^Outbox/ }).click();
            await expect
                .poll(() => first.getByText("Queue is clear", { exact: true }).isVisible())
                .toBe(true);
            const second = await context.newPage();
            await second.goto(url!);
            await visible(second, "button", "New issue");
            await second.getByPlaceholder("Search issues").fill(title);
            await visible(second, "button", new RegExp(title));
            const opener = second.getByRole("button", { name: "Open TanStack Devtools" });
            if (await opener.isVisible()) await opener.click();
            await second.getByRole("tab", { name: /^Outbox/ }).click();
            await context.setOffline(true);
            await first.getByRole("combobox", { name: "Change status from Open" }).click();
            await first.getByRole("listbox").getByRole("option", { name: "Waiting", exact: true }).click();
            await visible(first, "combobox", "Change status from Waiting");
            await visible(second, "combobox", "Change status from Waiting");
            await expect
                .poll(() =>
                    second
                        .getByRole("tab", { name: /^Outbox/ })
                        .locator("span[title]")
                        .getAttribute("title")
                )
                .toMatch(/^1 outbox entries/);
            await expect
                .poll(() => second.locator(".ps-outbox-attempts").innerText())
                .toMatch(/^Attempts: \d+$/);
            await first.close();
            await expect
                .poll(() =>
                    second
                        .getByRole("tab", { name: /^Outbox/ })
                        .locator("span[title]")
                        .getAttribute("title")
                )
                .toMatch(/^1 outbox entries/);
            // The persisted inspector still reads local data while the backend is inaccessible.
            await second.getByRole("tab", { name: "Objects", exact: true }).click();
            await second.getByRole("tab", { name: /^Outbox/ }).click();
            await context.setOffline(false);
            await expect
                .poll(() => second.getByText("Queue is clear", { exact: true }).isVisible())
                .toBe(true);
            await second.reload();
            await visible(second, "button", "New issue");
            await second.getByPlaceholder("Search issues").fill(title);
            await visible(second, "combobox", "Change status from Waiting");
            const devtoolsOpener = second.getByRole("button", { name: "Open TanStack Devtools" });
            if (await devtoolsOpener.isVisible()) await devtoolsOpener.click();
            await second.getByRole("tab", { name: "Tracing", exact: true }).click();
            await visible(second, "table", "Tracing timeline");
            const source = second.getByLabel("Trace source", { exact: true });
            expect(await source.inputValue()).toBe("1");
            expect(await source.locator("option:checked").innerText()).toBe("Shared worker");
            const panel = second.getByLabel("Tracing inspector", { exact: true });
            const viewport = second.getByLabel("Tracing timeline viewport", { exact: true });
            const panelBounds = await panel.boundingBox();
            const viewportBounds = await viewport.boundingBox();
            const operationTable = second.getByRole("table", { name: "Tracing timeline", exact: true });
            expect(await operationTable.locator(".ps-timeline-bar").count()).toBe(0);
            expect(await operationTable.getByRole("columnheader", { name: "Status" }).count()).toBe(1);
            const operation = second.getByRole("button", { name: "Replica.sync", exact: true }).first();
            await expect.poll(() => operation.isVisible()).toBe(true);
            await operation.click();
            await expect
                .poll(() => second.getByLabel("Trace details", { exact: true }).innerText())
                .toContain("Replica.sync");
            expect(await panel.boundingBox()).toEqual(panelBounds);
            expect(await viewport.boundingBox()).toEqual(viewportBounds);
            await visible(second, "table", "Operation waterfall");
            const details = second.getByLabel("Trace details", { exact: true });
            const closeBounds = await details
                .getByRole("button", { name: "Close trace details" })
                .boundingBox();
            const titleBounds = await details.locator("strong").first().boundingBox();
            expect(closeBounds!.x).toBeLessThan(titleBounds!.x);
            await second.getByRole("button", { name: "Close trace details", exact: true }).click();
            const table = second.getByRole("table", { name: "Tracing timeline", exact: true });
            await table.getByRole("button", { name: "Duration", exact: true }).click();
            expect(
                await table.getByRole("columnheader", { name: "Duration" }).getAttribute("aria-sort")
            ).toBe("descending");
            await table.getByRole("button", { name: "Duration", exact: true }).click();
            expect(
                await table.getByRole("columnheader", { name: "Duration" }).getAttribute("aria-sort")
            ).toBe("ascending");
            const roots = await table.getByRole("row").count();
            await second.getByRole("checkbox", { name: "Child spans", exact: true }).check();
            expect(await table.getByRole("row").count()).toBeGreaterThan(roots);
            await second.getByRole("checkbox", { name: "Child spans", exact: true }).uncheck();
            await second.getByRole("button", { name: "Pause", exact: true }).click();
            await visible(second, "button", "Resume live");
            await source.selectOption("0");
            await expect
                .poll(() =>
                    second
                        .getByRole("button", { name: "Replica.syncParent", exact: true })
                        .first()
                        .isVisible()
                )
                .toBe(true);
            await second.getByRole("button", { name: "Replica.watchParent", exact: true }).click();
            await visible(second, "table", "Subscription events");
            expect(await second.getByLabel("Trace details", { exact: true }).innerText()).toContain(
                "subscribed"
            );
            await second.getByRole("button", { name: "Close trace details", exact: true }).click();
            await second.getByPlaceholder("Search issues").fill("");
            await second.getByLabel("Filter by status", { exact: true }).selectOption("Waiting");
            await second.getByRole("tab", { name: "Queries", exact: true }).click();
            await expect
                .poll(() => second.getByLabel("Trace source", { exact: true }).isVisible())
                .toBe(false);
            await expect
                .poll(() => second.getByLabel("Active queries").locator(".ps-query-card").count())
                .toBeGreaterThan(0);
            await expect
                .poll(() => second.getByLabel("Active queries").locator("svg").count())
                .toBeGreaterThan(0);
            expect(await second.getByLabel("Active queries").innerText()).not.toContain('"_tag"');
            expect(await second.getByLabel("Queries inspector").innerText()).not.toContain(
                "Current live ontology"
            );
            expect(await second.getByRole("textbox", { name: "Filter queries" }).count()).toBe(0);
            expect(
                await second.getByLabel("Active queries").locator(".ps-query-field").count()
            ).toBeGreaterThan(0);
            expect(
                await second.getByLabel("Active queries").locator(".ps-query-literal").count()
            ).toBeGreaterThan(0);
            expect(
                await second
                    .getByLabel("Active queries")
                    .locator(".ps-query-component-target .ps-query-special")
                    .count()
            ).toBe(0);
            // Inactive filters must not become wildcard predicates with undefined guards.
            await second.getByLabel("Filter by status", { exact: true }).selectOption("All");
            await expect
                .poll(() =>
                    second
                        .getByLabel("Active queries")
                        .locator(".ps-query-component-target .ps-query-field")
                        .filter({ hasText: /Issue Title|Issue Status/ })
                        .count()
                )
                .toBe(0);
            const views = await second
                .getByRole("tablist", { name: "Ontology devtools views" })
                .getByRole("tab")
                .allTextContents();
            expect(views.slice(0, 5).map((value) => value.replace(/\d/g, "").trim())).toEqual([
                "Objects",
                "Outbox",
                "Queries",
                "Tracing",
                "Schema",
            ]);
            expect(await second.getByLabel("Active queries").innerText()).not.toMatch(
                /loads recorded|recent loads|fetched →|Last load unknown|No row limit|Limit:/
            );
            const alignment = await second.locator(".ps-query-sentence").evaluateAll((sentences) =>
                sentences.map((sentence) => {
                    const subject = sentence.querySelector(".ps-query-subject")!.getBoundingClientRect();
                    const keyword = sentence
                        .querySelector(":scope > .ps-query-keyword")!
                        .getBoundingClientRect();
                    return Math.abs(subject.y + subject.height / 2 - keyword.y - keyword.height / 2);
                })
            );
            expect(alignment.every((offset) => offset < 1)).toBe(true);
            await second.getByRole("tab", { name: "Schema", exact: true }).click();
            const graph = second.getByLabel("Ontology schema", { exact: true });
            await expect.poll(() => graph.locator(".react-flow__node").count()).toBeGreaterThan(0);
            await expect
                .poll(async () => (await graph.locator(".ps-schema-card").first().boundingBox())?.width ?? 0)
                .toBeGreaterThan(120);
            expect(await graph.innerText()).toContain("one-to-many");
            expect(await graph.innerText()).not.toContain("one-to-one");
            expect(await graph.locator(".react-flow__edge-text").allTextContents()).toEqual(["one-to-many"]);
            await graph.getByLabel("Project object type", { exact: true }).click();
            await visible(second, "table", "Object properties");
            expect(await second.getByLabel("Project schema details", { exact: true }).innerText()).toContain(
                "many Issues"
            );
            await second.getByRole("button", { name: "Close schema details", exact: true }).click();
            await graph.getByLabel("Issue object type", { exact: true }).click();
            expect(await second.getByLabel("Issue schema details", { exact: true }).innerText()).toContain(
                "one Project"
            );
            await second.getByRole("button", { name: "Close schema details", exact: true }).click();
            expect(fallback).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            await context.setOffline(false);
            await context.close();
        }
    }
);

test.skipIf(!url)(
    "single-process tracing identifies the host without an upstream source selector",
    async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        await context.addInitScript(() => {
            Object.defineProperty(globalThis, "SharedWorker", { value: undefined, configurable: true });
        });
        try {
            const page = await context.newPage();
            await page.goto(url!);
            await visible(page, "heading", "Connect profile");
            await page.getByRole("button", { name: "Connect", exact: true }).click();
            await visible(page, "button", "New issue");
            const opener = page.getByRole("button", { name: "Open TanStack Devtools" });
            await opener.click();
            await page.getByRole("tab", { name: "Tracing", exact: true }).click();
            await visible(page, "table", "Tracing timeline");
            await expect.poll(() => page.getByLabel("Tracing inspector").innerText()).toContain("This tab");
            expect(await page.getByLabel("Trace source", { exact: true }).count()).toBe(0);
            expect(await page.getByLabel("Tracing inspector").innerText()).not.toContain("No parent replica");
        } finally {
            await context.close();
        }
    }
);

test.skipIf(!url)("navigation preserves the devtools panel, selected tab and trace source", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
        const page = await context.newPage();
        await page.goto(url!);
        await visible(page, "heading", "Connect profile");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await visible(page, "button", "New issue");
        // Keep the new fixture above the open devtools drawer in the sorted sidebar.
        const project = `000 Navigation acceptance ${crypto.randomUUID().slice(0, 8)}`;
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Create project", exact: true });
        await dialog.getByLabel("Project name", { exact: true }).fill(project);
        await dialog.getByRole("button", { name: "Create project", exact: true }).click();
        await visible(page, "button", project);
        await page.getByRole("button", { name: "Open TanStack Devtools", exact: true }).click();
        const tracingTab = page.getByRole("tab", { name: "Tracing", exact: true });
        await tracingTab.click();
        const source = page.getByLabel("Trace source", { exact: true });
        await source.selectOption("0");
        const original = await page.getByLabel("Tracing inspector", { exact: true }).elementHandle();
        await page.getByRole("button", { name: project, exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname.startsWith("/project/")).toBe(true);
        await visible(page, "heading", project);
        expect(await tracingTab.getAttribute("aria-selected")).toBe("true");
        expect(await source.inputValue()).toBe("0");
        expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
        await page.getByRole("button", { name: /^All issues/ }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/");
        await visible(page, "heading", "All issues");
        expect(await tracingTab.getAttribute("aria-selected")).toBe("true");
        expect(await source.inputValue()).toBe("0");
        expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    } finally {
        await context.close();
    }
});

test.skipIf(!url)(
    "optimistic issue creation closes the form and toasts rejection without retaining pending work",
    async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const project = `Validation project ${crypto.randomUUID().slice(0, 8)}`;
        const title = `Validation issue ${crypto.randomUUID().slice(0, 8)}`;
        try {
            const first = await context.newPage();
            await first.goto(url!);
            await visible(first, "heading", "Connect profile");
            await first.getByRole("button", { name: "Connect", exact: true }).click();
            await visible(first, "button", "New issue");
            await first.getByRole("button", { name: "Create project", exact: true }).click();
            const projectForm = first.getByRole("dialog", { name: "Create project", exact: true });
            await projectForm.getByLabel("Project name", { exact: true }).fill(project);
            await projectForm.getByRole("button", { name: "Create project", exact: true }).click();
            await visible(first, "button", project);
            const second = await context.newPage();
            await second.goto(url!);
            await visible(second, "button", project);
            await first.getByRole("button", { name: "New issue", exact: true }).click();
            const form = first.getByRole("dialog", { name: "Create issue", exact: true });
            await form.getByLabel("Title", { exact: true }).fill(title);
            await form.getByLabel("Project", { exact: true }).selectOption({ label: project });
            await second.getByRole("button", { name: project, exact: true }).click({ button: "right" });
            await second.getByRole("menuitem", { name: "Delete project", exact: true }).click();
            await expect
                .poll(() => second.getByRole("button", { name: project, exact: true }).count())
                .toBe(0);
            await form.getByRole("button", { name: "Create issue", exact: true }).click();
            await expect.poll(() => form.count()).toBe(0);
            await expect
                .poll(() => first.locator(".app-toast").innerText())
                .toContain("Couldn’t create issue");
            expect(await first.locator(".app-toast").innerText()).toContain("Project: Choose a valid value.");
            await first.locator(".app-toast-close").click();
            await second.getByRole("button", { name: "Open TanStack Devtools", exact: true }).click();
            await second.getByRole("tab", { name: /^Outbox/ }).click();
            await expect
                .poll(() => second.getByText("Queue is clear", { exact: true }).isVisible())
                .toBe(true);
            await first.getByRole("button", { name: "New issue", exact: true }).click();
            await form.getByLabel("Title", { exact: true }).fill(title);
            await form.getByRole("button", { name: "Create issue", exact: true }).click();
            await expect.poll(() => form.count()).toBe(0);
            await first.getByPlaceholder("Search issues").fill(title);
            await visible(first, "button", new RegExp(title));
            await expect
                .poll(() => second.getByText("Queue is clear", { exact: true }).isVisible())
                .toBe(true);
        } finally {
            await context.close();
        }
    }
);
