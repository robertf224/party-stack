import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { demandAttribution } from "@party-stack/ontology-devtools/vite";
import { chromium, type Page } from "playwright";
import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";

const url = env.ISSUE_TRACKER_TEST_URL;

async function verifyDisclosureAlignment(summary: ReturnType<Page["locator"]>) {
    const caret = await summary.locator(".ps-disclosure-chevron").boundingBox();
    const label = await summary.locator(".ps-disclosure-label").boundingBox();
    expect(caret).not.toBeNull();
    expect(label).not.toBeNull();
    expect(Math.abs(caret!.y + caret!.height / 2 - label!.y - label!.height / 2)).toBeLessThan(1);
}

async function verifyTracing(page: Page) {
    await page.getByRole("button", { name: "Record trace fixtures", exact: true }).click();
    await page.getByRole("tab", { name: "Tracing", exact: true }).click();
    const table = page.getByRole("table", { name: "Tracing timeline", exact: true });
    const demand = table
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: "Demand", exact: true }) });
    await expect.poll(() => demand.innerText()).toContain("Stopped");
    expect(
        await table
            .getByRole("row")
            .filter({ has: page.getByRole("button", { name: "Traces", exact: true }) })
            .innerText()
    ).toContain("Stopped");
    expect(
        await table
            .getByRole("row")
            .filter({ has: page.getByRole("button", { name: "Fixture.cancelled", exact: true }) })
            .innerText()
    ).toContain("Cancelled");
    expect(await demand.locator("td").nth(4).innerText()).toBe("1");
    const textRight = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().right;
    };
    const eventHeader = await table
        .getByRole("columnheader", { name: "Events", exact: true })
        .evaluate(textRight);
    const eventCell = await demand.locator("td").nth(4).evaluate(textRight);
    expect(Math.abs(eventHeader - eventCell)).toBeLessThan(1);
    const durationHeader = await table
        .getByRole("button", { name: "Duration", exact: true })
        .getByText("Duration", { exact: true })
        .evaluate(textRight);
    const durationCell = await demand.locator("td").nth(3).evaluate(textRight);
    expect(Math.abs(durationHeader - durationCell)).toBeLessThan(1);
    const startedHeader = await table
        .getByRole("button", { name: "Started", exact: true })
        .getByText("Started", { exact: true })
        .boundingBox();
    const startedCell = await demand
        .locator("td")
        .nth(2)
        .evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect().left;
        });
    expect(Math.abs(startedHeader!.x - startedCell)).toBeLessThan(1);
    await demand.getByRole("button", { name: "Demand", exact: true }).click();
    await expect
        .poll(() => page.getByLabel("Trace details", { exact: true }).innerText())
        .toContain("No error was reported");
    await page.getByRole("button", { name: "Close trace details", exact: true }).click();
    await table.getByRole("button", { name: "Fixture.failure", exact: true }).click();
    await expect
        .poll(() => page.getByLabel("Trace details", { exact: true }).innerText())
        .toContain("Fixture connection refused");
    expect(await page.getByLabel("Trace details", { exact: true }).innerText()).toContain("Failed");
}

async function verifyThemeSurfaces(page: Page) {
    for (const theme of ["dark", "light"] as const) {
        if (theme === "light")
            await page.getByRole("button", { name: "Use light theme", exact: true }).click();
        await page.getByRole("tab", { name: "Objects", exact: true }).click();
        const canvas = await page
            .getByRole("tablist", { name: "Ontology devtools views" })
            .evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
        const heading = await page
            .locator(".ps-object-table-header th")
            .first()
            .evaluate((el) => ({
                background: getComputedStyle(el).backgroundColor,
                border: getComputedStyle(el).borderBottomColor,
            }));
        for (const [tab, background, surface, border] of [
            ["Outbox", ".ps-outbox", ".ps-outbox-empty", ".ps-outbox-empty"],
            ["Queries", ".ps-diagnostics-screen", ".ps-query-card", ".ps-query-card"],
            ["Tracing", ".ps-diagnostics-screen", ".ps-timeline th", ".ps-timeline th"],
            ["Schema", ".ps-schema", ".ps-schema-card", ".ps-schema-card"],
        ]) {
            await page
                .getByRole("tab", { name: tab === "Outbox" ? /^Outbox/ : tab, exact: tab !== "Outbox" })
                .click();
            expect(
                await page
                    .locator(background!)
                    .first()
                    .evaluate((el) => getComputedStyle(el).backgroundColor)
            ).toBe(canvas);
            expect(
                await page
                    .locator(surface!)
                    .first()
                    .evaluate((el) => getComputedStyle(el).backgroundColor)
            ).toBe(heading.background);
            expect(
                await page
                    .locator(border!)
                    .first()
                    .evaluate((el) => getComputedStyle(el).borderBottomColor)
            ).toBe(heading.border);
        }
        await page.getByRole("tab", { name: "Objects", exact: true }).click();
        await page.getByRole("button", { name: "Columns", exact: true }).click();
        expect(await page.getByRole("menu").evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
            heading.border
        );
        expect(await page.getByRole("menu").evaluate((el) => getComputedStyle(el).color)).not.toBe(
            "rgb(1, 222, 3)"
        );
        await page.getByRole("menu").press("Escape");
    }
}
test.skipIf(!url)(
    "query cards find mounted instances, follow query changes, and release removed consumers",
    async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
        const cacheDir = await mkdtemp(join(tmpdir(), "party-stack-attribution-"));
        const fixture = await createServer({
            configFile: false,
            cacheDir,
            root: fileURLToPath(new URL(".", import.meta.url)),
            plugins: [demandAttribution()],
            server: { host: "127.0.0.1", port: 0 },
        });
        await fixture.listen();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            await page.goto(new URL("/attribution.html", fixture.resolvedUrls!.local[0]!).href);
            const objectRows = page.locator(".ps-object-data-row");
            await expect.poll(() => objectRows.count()).toBe(2);
            const rowHeights = () =>
                objectRows.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
            const heightsBefore = await rowHeights();
            // The app's unscoped styles, including !important resets, must stay outside the panel.
            await page.addStyleTag({
                content: `
                button, select { color: rgb(1, 222, 3) !important; background: rgb(255, 0, 255) !important; }
                td { padding-block: 70px !important; }
                svg { width: 90px !important; height: 90px !important; }
            `,
            });
            expect(await rowHeights()).toEqual(heightsBefore);
            const applicationButton = page.getByRole("button", {
                name: "Load attachment preview",
                exact: true,
            });
            expect(await applicationButton.evaluate((el) => getComputedStyle(el).color)).toBe(
                "rgb(1, 222, 3)"
            );
            const columns = page.getByRole("button", { name: "Columns", exact: true });
            expect(await columns.evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(1, 222, 3)");
            expect(await columns.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
            await columns.click();
            const menu = page.getByRole("menu");
            await expect.poll(() => menu.isVisible()).toBe(true);
            expect(
                await menu.evaluate((el) =>
                    (el.getRootNode() as ShadowRoot).host.getAttribute("data-ps-devtools")
                )
            ).toBe("overlays");
            await menu.press("Escape");
            const headerBefore = await page.locator(".ps-object-table-header").boundingBox();
            await page.getByRole("button", { name: "Load attachment preview", exact: true }).click();
            const preview = page.getByRole("img", { name: "Preview image", exact: true });
            await expect.poll(() => preview.isVisible()).toBe(true);
            await expect.poll(() => preview.evaluate((img) => (img as HTMLImageElement).complete)).toBe(true);
            expect(await rowHeights()).toEqual(heightsBefore);
            expect(await page.locator(".ps-object-table-header").boundingBox()).toEqual(headerBefore);
            // The compact image still opens its full preview, despite the bounded cell.
            await page.getByRole("button", { name: "Open Preview image", exact: true }).click();
            await expect.poll(() => page.getByRole("dialog").isVisible()).toBe(true);
            expect(
                await page
                    .getByRole("dialog")
                    .evaluate((el) => (el.getRootNode() as ShadowRoot).host.getAttribute("data-ps-devtools"))
            ).toBe("overlays");
            const dialogBounds = await page.getByRole("dialog").boundingBox();
            const shellBounds = await page.getByTestId("devtools-shell").boundingBox();
            expect(dialogBounds!.y).toBeLessThan(shellBounds!.y);
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await expect
                .poll(() =>
                    page
                        .getByRole("button", { name: "Open Preview image", exact: true })
                        .evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el)
                )
                .toBe(true);
            await page.getByRole("tab", { name: "Queries", exact: true }).click();
            const one = page
                .locator(".ps-query-card")
                .filter({ has: page.getByText('"one"', { exact: true }) });
            const two = page
                .locator(".ps-query-card")
                .filter({ has: page.getByText('"two"', { exact: true }) });
            await verifyDisclosureAlignment(one.locator(".ps-query-pushdown > summary"));
            await one.locator(".ps-query-pushdown > summary").click();
            await verifyDisclosureAlignment(one.locator(".ps-query-pushdown > summary"));
            await two.locator(".ps-query-pushdown > summary").click();
            await expect
                .poll(() => one.locator(".ps-query-owners").getAttribute("aria-label"))
                .toBe("2 components");
            await expect
                .poll(() => two.locator(".ps-query-owners").getAttribute("aria-label"))
                .toBe("1 component");
            expect(await one.locator("header .ps-query-owner-name").allTextContents()).toEqual([
                "NoteList ×2",
            ]);
            expect(await two.locator("header .ps-query-owner-name").allTextContents()).toEqual(["NoteList"]);
            await expect
                .poll(() => one.locator(".ps-query-execution").innerText())
                .toMatch(/Satisfied by local coverage|Reused this query’s previous result/);
            const sourceTier = one.locator(".ps-query-step[data-source-state]");
            expect(await sourceTier.locator(".ps-query-step-note > strong").allTextContents()).toEqual([
                "Filter:",
                "Data:",
            ]);
            expect(await sourceTier.locator(".ps-query-refresh").isVisible()).toBe(true);
            expect(await one.locator("details.ps-query-previous-load").count()).toBe(0);
            await expect.poll(() => one.locator('[data-execution="source"]').count()).toBe(1);
            expect(await one.locator(".ps-query-execution").innerText()).toContain("Fixture storage");
            expect(await one.locator(".ps-query-native pre").isVisible()).toBe(false);
            await verifyDisclosureAlignment(one.locator(".ps-query-native > summary"));
            await one.locator(".ps-query-native > summary").click();
            await verifyDisclosureAlignment(one.locator(".ps-query-native > summary"));
            const nativeCode = one.locator(".ps-query-native pre code");
            expect(JSON.parse(await nativeCode.innerText())).toMatchObject({ where: { op: "eq" } });
            expect(await nativeCode.locator(".hljs-attr").count()).toBeGreaterThan(0);
            expect(await nativeCode.locator(".hljs-string").count()).toBeGreaterThan(0);
            const firstId = await page.getByTestId("first").getAttribute("data-ps-demand-owner");
            const secondId = await page.getByTestId("second").getAttribute("data-ps-demand-owner");
            const otherId = await page.getByTestId("other").getAttribute("data-ps-demand-owner");
            expect(new Set([firstId, secondId, otherId]).size).toBe(3);
            expect(firstId).toBeTruthy();
            expect(await page.getByTestId("first-portal").getAttribute("data-ps-demand-owner")).toBe(firstId);
            const before = await page.getByLabel("Backend loads").innerText();
            await one.locator(".ps-query-component-target").hover();
            await one.locator(".ps-query-component-target").click();
            await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
            await expect
                .poll(() => page.locator(`.ps-demand-highlight[data-owner-id^='${firstId}:']`).count())
                .toBeGreaterThan(0);
            await one.locator(".ps-query-owners").hover();
            await expect
                .poll(() => page.locator(`.ps-demand-highlight[data-owner-id^='${firstId}:']`).count())
                .toBeGreaterThan(0);
            const highlightZ = await page
                .locator(".ps-demand-highlights")
                .evaluate((el) => Number(getComputedStyle(el).zIndex));
            const panelZ = await page
                .getByTestId("devtools-shell")
                .evaluate((el) => Number(getComputedStyle(el).zIndex));
            expect(highlightZ).toBeLessThan(panelZ);
            expect(await page.locator(`.ps-demand-highlight[data-owner-id^='${otherId}:']`).count()).toBe(0);
            expect(await page.locator("[data-ps-devtools] [data-ps-demand-owner]").count()).toBe(0);
            await page.getByRole("button", { name: "Hide second", exact: true }).click();
            await expect
                .poll(() => one.locator(".ps-query-owners").getAttribute("aria-label"))
                .toBe("1 component");
            expect(await one.locator(".ps-query-native pre").isVisible()).toBe(true);
            await one.locator(".ps-query-component-target").focus();
            await expect
                .poll(() => page.locator(`.ps-demand-highlight[data-owner-id^='${secondId}:']`).count())
                .toBe(0);
            expect(await page.getByLabel("Backend loads").innerText()).toBe(before);
            await page.getByRole("button", { name: "Switch first", exact: true }).click();
            await expect
                .poll(() => two.locator(".ps-query-owners").getAttribute("aria-label"))
                .toBe("2 components");
            await expect.poll(() => one.locator(".ps-query-owners").count()).toBe(0);
            await two.locator(".ps-query-component-target").focus();
            await two.locator(".ps-query-component-target").press("Enter");
            await expect
                .poll(() => page.locator(`.ps-demand-highlight[data-owner-id^='${firstId}:']`).count())
                .toBeGreaterThan(0);
            await page.getByRole("button", { name: "Switch first", exact: true }).focus();
            await page.mouse.move(0, 0);
            await expect.poll(() => page.locator(".ps-demand-highlight").count()).toBe(0);
            await page.getByRole("button", { name: "Use pooled", exact: true }).click();
            const pooled = page.locator(".ps-query-card").filter({ hasText: "— all rows" });
            await pooled.locator(".ps-query-pushdown > summary").click();
            await expect
                .poll(() => pooled.locator(".ps-query-owners").getAttribute("aria-label"))
                .toBe("2 components");
            // The pooled source adds one full-source request after the two
            // equality requests. Wait for it before measuring inspection work.
            await expect.poll(() => page.getByLabel("Backend loads").innerText()).toBe("3");
            const pooledId = await page.getByTestId("pooled-first").getAttribute("data-ps-demand-owner");
            const pooledLoads = await page.getByLabel("Backend loads").innerText();
            await pooled.locator(".ps-query-component-target").hover();
            await pooled.locator(".ps-query-component-target").click();
            await expect
                .poll(() => page.locator(`.ps-demand-highlight[data-owner-id^='${pooledId}:']`).count())
                .toBeGreaterThan(0);
            expect(await page.getByLabel("Backend loads").innerText()).toBe(pooledLoads);
            await verifyTracing(page);
            await verifyThemeSurfaces(page);
            expect(errors).toEqual([]);
        } catch (error) {
            console.error({
                errors,
                queries: await page.locator(".ps-query-list").allTextContents(),
                tags: await page.locator("[data-ps-demand-owner]").count(),
            });
            throw error;
        } finally {
            await browser.close();
            await fixture.close();
            await rm(cacheDir, { recursive: true, force: true });
        }
    }
);
