import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";

test.each([false, true])(
    "provider owns late acquisitions and selection cleanup (direct backend: %s)",
    async (construction) => {
        const server = await createServer({
            root: fileURLToPath(new URL("../", import.meta.url)),
            cacheDir: "node_modules/.vite/provider.browser.test",
            server: { host: "127.0.0.1", port: 0 },
            logLevel: "error",
        });
        const browser = await chromium.launch();
        try {
            await server.listen();
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(
                `${server.resolvedUrls!.local[0]}e2e/provider.html${construction ? "?construction" : ""}`
            );
            const requests = () =>
                page.evaluate(() =>
                    (
                        Reflect.get(window, "fixture") as {
                            requests(): { userId: string; closed: number }[];
                        }
                    ).requests()
                );
            const release = (index: number) =>
                page.evaluate(
                    (index) =>
                        (Reflect.get(window, "fixture") as { release(index: number): void }).release(index),
                    index
                );
            await expect.poll(requests).toEqual([{ userId: "alice", closed: 0 }]);
            await page.getByRole("button", { name: "bob", exact: true }).click();
            await expect.poll(async () => (await requests()).length, { timeout: 10_000 }).toBe(2);
            await release(0);
            await expect.poll(async () => (await requests())[0]!.closed).toBe(1);
            await release(1);
            await expect
                .poll(() => page.getByTestId("account").textContent(), { timeout: 10_000 })
                .toBe("bob");
            expect(await page.getByTestId("label").textContent()).toBe(
                construction ? "Local" : "Environment"
            );
            await page.getByRole("button", { name: "Rerender", exact: true }).click();
            await expect.poll(() => page.getByTestId("render-count").textContent()).toBe("1");
            expect(await requests()).toHaveLength(2);
            await page.getByRole("button", { name: "carol", exact: true }).click();
            await expect.poll(async () => (await requests())[1]!.closed).toBe(1);
            await expect.poll(async () => (await requests()).length).toBe(3);
            await page.getByRole("button", { name: "bob", exact: true }).click();
            await expect.poll(async () => (await requests()).length).toBe(4);
            expect(await page.getByTestId("account").count()).toBe(0);
            expect(await page.getByTestId("pending").isVisible()).toBe(true);
            await release(2);
            await expect.poll(async () => (await requests())[2]!.closed).toBe(1);
            await release(3);
            await expect
                .poll(() => page.getByTestId("account").textContent(), { timeout: 10_000 })
                .toBe("bob");
            await page.getByRole("button", { name: "Unmount", exact: true }).click();
            await expect.poll(async () => (await requests())[3]!.closed).toBe(1);
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
            await server.close();
        }
    },
    30_000
);

test("a parent Suspense boundary preserves the provider owner through StrictMode startup", async () => {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/provider.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/provider.html?construction&strict`);
        const rows = () =>
            page.evaluate(() =>
                (Reflect.get(window, "fixture") as { requests(): { closed: number }[] }).requests()
            );
        await expect.poll(async () => (await rows()).length).toBe(1);
        expect(await page.getByTestId("pending").isVisible()).toBe(true);
        await page.evaluate(() => {
            const fixture = Reflect.get(window, "fixture") as { release(index: number): void };
            fixture.release(0);
        });
        await expect.poll(() => page.getByTestId("account").textContent(), { timeout: 10_000 }).toBe("alice");
        await expect.poll(async () => (await rows()).map((row) => row.closed)).toEqual([0]);
        await page.getByRole("button", { name: "Unmount" }).click();
        await expect.poll(async () => (await rows()).map((row) => row.closed)).toEqual([1]);
        expect(errors).toEqual([]);
    } finally {
        await browser.close();
        await server.close();
    }
}, 30_000);

test("the environment owns one transport across selection changes and closes it on unmount", async () => {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/provider.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/provider.html?owned&strict`);
        const state = () =>
            page.evaluate(() =>
                (
                    Reflect.get(window, "fixture") as { transport(): { opened: number; closed: number } }
                ).transport()
            );
        const requests = () =>
            page.evaluate(() =>
                (
                    Reflect.get(window, "fixture") as { requests(): { userId: string; closed: number }[] }
                ).requests()
            );
        await expect.poll(async () => (await requests()).length).toBe(1);
        expect(await state()).toEqual({ opened: 1, closed: 0 });
        await page.getByRole("button", { name: "bob", exact: true }).click();
        await expect.poll(async () => (await requests()).length, { timeout: 10_000 }).toBe(2);
        await page.evaluate(() => {
            const f = Reflect.get(window, "fixture") as { release(i: number): void };
            f.release(0);
            f.release(1);
        });
        await expect.poll(() => page.getByTestId("account").textContent(), { timeout: 10_000 }).toBe("bob");
        expect(await state()).toEqual({ opened: 1, closed: 0 });
        await page.evaluate(() => (Reflect.get(window, "fixture") as { close(): void }).close());
        await expect.poll(state).toEqual({ opened: 1, closed: 1 });
        await expect.poll(async () => (await requests()).map((r) => r.closed)).toEqual([1, 1]);
    } finally {
        await browser.close();
        await server.close();
    }
}, 30_000);

test("Connect owns its command facade and view, runs auth commands directly and releases both", async () => {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/provider.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/provider.html?owned&strict&connect`);
        const requests = () =>
            page.evaluate(() =>
                (Reflect.get(window, "fixture") as { requests(): { closed: number }[] }).requests()
            );
        const release = (index: number) =>
            page.evaluate(
                (index) => (Reflect.get(window, "fixture") as { release(i: number): void }).release(index),
                index
            );
        await expect.poll(async () => (await requests()).length).toBe(1);
        await release(0);
        await expect.poll(async () => (await requests()).length, { timeout: 10_000 }).toBe(2);
        await release(1);
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        await page.getByRole("button", { name: "Disconnected", exact: true }).waitFor();
        expect(
            await page.evaluate(() => (Reflect.get(window, "fixture") as { commands(): string[] }).commands())
        ).toEqual(["disconnectExternalSession"]);
        await page.evaluate(() => (Reflect.get(window, "fixture") as { close(): void }).close());
        await expect.poll(async () => (await requests()).map((r) => r.closed)).toEqual([1, 1]);
        expect(errors).toEqual([]);
    } finally {
        await browser.close();
        await server.close();
    }
}, 30_000);

type StartupFixture = {
    startup(): { childOpens: number; resolved: number };
    transport(): { opened: number; closed: number };
    requests(): { userId: string; closed: number }[];
    release(index: number): void;
    releaseTransport(): void;
    replaceTransport(): void;
    close(): void;
};

test.each(["ready", "strict", "unmount", "replace", "fail", "unused-error"])(
    "a pending shared transport composes with child acquisition (%s)",
    async (mode) => {
        const server = await createServer({
            root: fileURLToPath(new URL("../", import.meta.url)),
            cacheDir: "node_modules/.vite/provider.browser.test",
            server: { host: "127.0.0.1", port: 0 },
            logLevel: "error",
        });
        const browser = await chromium.launch();
        try {
            await server.listen();
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(
                `${server.resolvedUrls!.local[0]}e2e/provider.html?owned&held&${mode === "unused-error" ? "fail&unused" : mode}`
            );
            const state = () =>
                page.evaluate(() => {
                    const fixture = Reflect.get(window, "fixture") as StartupFixture;
                    return { ...fixture.startup(), ...fixture.transport(), requests: fixture.requests() };
                });
            // Deterministic ordering, not a timing threshold: the child's runtime
            // has opened while its shared transport is deliberately unresolved.
            // An independently suspending environment cannot mount that child.
            await expect.poll(async () => (await state()).opened).toBe(1);
            await expect.poll(async () => (await state()).childOpens).toBe(mode === "unused-error" ? 0 : 1);
            expect(await state()).toMatchObject({ opened: 1, closed: 0, resolved: 0, requests: [] });
            if (mode === "replace") {
                await page.evaluate(() =>
                    (Reflect.get(window, "fixture") as StartupFixture).replaceTransport()
                );
                await expect
                    .poll(async () => (await state()).requests)
                    .toEqual([{ userId: "bob", closed: 0 }]);
                await page.evaluate(() => (Reflect.get(window, "fixture") as StartupFixture).release(0));
                await expect.poll(() => page.getByTestId("account").textContent()).toBe("bob");
            }
            if (mode === "unmount")
                await page.evaluate(() => (Reflect.get(window, "fixture") as StartupFixture).close());
            await page.evaluate(() => (Reflect.get(window, "fixture") as StartupFixture).releaseTransport());
            if (mode === "fail" || mode === "unused-error") {
                await expect
                    .poll(() => page.getByTestId("error").textContent())
                    .toBe("Fixture transport failed");
                expect(await page.getByTestId("error").getAttribute("data-error-kind")).toBe("Unavailable");
                await expect.poll(async () => (await state()).closed).toBe(1);
                expect((await state()).requests).toEqual([]);
            } else {
                const requestCount = mode === "replace" ? 2 : 1;
                await expect.poll(async () => (await state()).requests.length).toBe(requestCount);
                await page.evaluate(
                    (index) => (Reflect.get(window, "fixture") as StartupFixture).release(index),
                    requestCount - 1
                );
                if (mode === "unmount") {
                    await expect.poll(async () => (await state()).requests[0]!.closed).toBe(1);
                    expect(await page.getByTestId("account").count()).toBe(0);
                } else {
                    await expect
                        .poll(() => page.getByTestId("account").textContent())
                        .toBe(mode === "replace" ? "bob" : "alice");
                    if (mode === "replace")
                        await expect.poll(async () => (await state()).requests[1]!.closed).toBe(1);
                    await page.evaluate(() => (Reflect.get(window, "fixture") as StartupFixture).close());
                }
                await expect.poll(async () => (await state()).closed).toBe(mode === "replace" ? 2 : 1);
                await expect
                    .poll(async () => (await state()).requests.every((request) => request.closed === 1))
                    .toBe(true);
            }
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
            await server.close();
        }
    },
    30_000
);
