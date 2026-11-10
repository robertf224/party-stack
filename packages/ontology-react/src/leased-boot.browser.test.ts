import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";
import type { Page } from "playwright";

type State = {
    acquired: number;
    closed: number;
    starts: string[];
    loads: { source: string; limit?: number }[];
    releases: number;
    releasedSources: string[];
    cleanups: string[];
    fallbacks: number;
    providerFallbacks: number;
    mountedAt?: number;
    firstRowsAt?: number;
    renders: number;
    ready: boolean;
    failure?: string;
    preloadedLoads: number;
    sameCollection: boolean;
    handoffs: string[];
    queryGraphs: number;
    queryStatuses: string[];
};
type Fixture = {
    state(): State;
    releaseAcquisition(): void;
    rejectAcquisition(): void;
    release(name: string): void;
    reject(name: string): void;
    mount(): Promise<void>;
    publish(title: string): Promise<void>;
    unmount(): void;
    close(): void;
};
const reports: unknown[] = [];
const state = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, "leasedBootFixture") as Fixture).state());
const command = (page: Page, name: "release" | "reject", source: string) =>
    page.evaluate(({ name, source }) => (Reflect.get(window, "leasedBootFixture") as Fixture)[name](source), {
        name,
        source,
    });
async function withFixture(mode: string, run: (page: Page) => Promise<void>) {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/leased-boot.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/leased-boot.html?${mode}`);
        await run(page).catch(async (error: unknown) => {
            console.info("Leased boot failure", {
                mode,
                state: await state(page),
                body: await page.locator("body").innerText(),
                errors,
            });
            throw error;
        });
        expect(errors).toEqual([]);
        reports.push({ mode, state: await state(page) });
        writeFileSync("/tmp/party-leased-boot-proof.json", JSON.stringify(reports, null, 2));
    } finally {
        await browser.close();
        await server.close();
    }
}

test.each(["root", "nested", "root&stagger", "root&page50"])(
    "an explicit query lease preserves %s fragment refs through the same-Collection handoff",
    async (mode) => {
        await withFixture(mode, async (page) => {
            const size = mode.includes("page50") ? 50 : 2;
            const ids = (length: number) => Array.from({ length }, (_, n) => String(n + 1)).join(",");
            if (mode.startsWith("root")) {
                // All independent requests begin before any data is released.
                await expect
                    .poll(async () =>
                        [...new Set((await state(page)).loads.map((load) => load.source))].sort()
                    )
                    .toEqual(["notebooks", "notes", "preferences"]);
            } else {
                await expect.poll(async () => (await state(page)).starts.includes("notebooks")).toBe(true);
                // A real nested correlation may need its parent rows. It still
                // completes before React mounts, including the list recipe bridge.
                await command(page, "release", "notebooks");
                await expect.poll(async () => (await state(page)).starts.includes("notes")).toBe(true);
            }
            if (mode.includes("stagger")) {
                await command(page, "release", "preferences");
                await command(page, "release", "notebooks");
                // A real subscription owns the graphs through an arbitrary
                // wait. Correctness does not depend on extending a GC timer.
                await page.waitForTimeout(120);
                const held = await state(page);
                expect(held.releasedSources).not.toContain("preferences");
                expect(held.releasedSources).not.toContain("notebooks");
            }
            for (const name of ["preferences", "notebooks", "notes"]) await command(page, "release", name);
            await expect.poll(async () => (await state(page)).ready).toBe(true);
            const before = await state(page);
            await page.evaluate(() => (Reflect.get(window, "leasedBootFixture") as Fixture).mount());
            await expect.poll(() => page.getByTestId("ids").textContent()).toBe(ids(size));
            expect(await page.getByTestId("preview").allTextContents()).toEqual(
                Array.from({ length: size }, (_, n) => `Note ${n + 1}`)
            );
            expect(await page.getByTestId("width").textContent()).toContain("240");
            expect(await page.getByRole("heading", { name: "Notes" }).count()).toBe(1);
            await page.getByRole("button", { name: "Rerender 0" }).click();
            await expect.poll(() => page.getByRole("button", { name: "Rerender 1" }).count()).toBe(1);
            const mounted = await state(page);
            console.info("Leased boot proof", {
                mode,
                providerFallbacks: mounted.providerFallbacks,
                dataFallbacks: mounted.fallbacks,
                commitMs: mounted.firstRowsAt! - mounted.mountedAt!,
                before: before.loads,
                after: mounted.loads,
            });
            expect(mounted.sameCollection).toBe(true);
            expect(mounted.queryGraphs).toBe(mode === "nested" ? 2 : 3);
            if (mode === "nested") {
                // Existing useListFragment intentionally reroots the child for
                // independent pagination. Parent queries must remain borrowed.
                expect(mounted.loads.filter((load) => load.source !== "notes")).toEqual(
                    before.loads.filter((load) => load.source !== "notes")
                );
            } else expect(mounted.loads).toEqual(before.loads);
            expect(mounted.fallbacks).toBe(0);
            expect(mounted.providerFallbacks).toBe(0);
            expect(mounted.acquired).toBe(1);
            expect(mounted.closed).toBe(0);
            await page.evaluate(() =>
                (Reflect.get(window, "leasedBootFixture") as Fixture).publish("Changed")
            );
            await expect.poll(() => page.getByTestId("preview").first().textContent()).toBe("Changed");
            await page.getByRole("button", { name: "More", exact: true }).click();
            await expect.poll(() => page.getByTestId("ids").textContent()).toBe(ids(size * 2));
            expect((await state(page)).fallbacks).toBe(0);
            await page.evaluate(() => (Reflect.get(window, "leasedBootFixture") as Fixture).unmount());
            await expect
                .poll(async () =>
                    (await state(page)).queryStatuses.every((status) => status === "cleaned-up")
                )
                .toBe(true);
            expect((await state(page)).closed).toBe(0); // Provider never owns the view.
            await page.evaluate(() => (Reflect.get(window, "leasedBootFixture") as Fixture).close());
            await expect.poll(async () => (await state(page)).closed).toBe(1);
            await expect
                .poll(async () => (await state(page)).cleanups.sort())
                .toEqual(["notebooks", "notes", "preferences"]);
        });
    },
    30_000
);

test("a failed parallel preload closes the view and its other pending source owners", async () => {
    await withFixture("root", async (page) => {
        await expect.poll(async () => (await state(page)).starts.length).toBe(3);
        await command(page, "reject", "notes");
        await expect.poll(async () => (await state(page)).failure).toBe("Fixture preload failed");
        await expect.poll(async () => (await state(page)).closed).toBe(1);
        await expect
            .poll(async () => (await state(page)).cleanups.sort())
            .toEqual(["notebooks", "notes", "preferences"]);
        await page.evaluate(() => (Reflect.get(window, "leasedBootFixture") as Fixture).close());
        expect((await state(page)).closed).toBe(1);
    });
}, 30_000);

test.each(["resolve", "reject"])(
    "an abandoned acquisition cleans its late %s without mounting or starting queries",
    async (mode) => {
        await withFixture("root&held-acquisition", async (page) => {
            expect((await state(page)).acquired).toBe(0);
            await page.evaluate(() => (Reflect.get(window, "leasedBootFixture") as Fixture).close());
            await page.evaluate((mode) => {
                const fixture = Reflect.get(window, "leasedBootFixture") as Fixture;
                if (mode === "resolve") fixture.releaseAcquisition();
                else fixture.rejectAcquisition();
            }, mode);
            await expect
                .poll(async () => (await state(page)).failure)
                .toBe(mode === "resolve" ? "Acquisition abandoned" : "Fixture acquisition failed");
            expect(await state(page)).toMatchObject({
                acquired: mode === "resolve" ? 1 : 0,
                closed: mode === "resolve" ? 1 : 0,
                starts: [],
                loads: [],
                renders: 0,
            });
        });
    },
    30_000
);
