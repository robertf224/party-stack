import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const mode = process.argv[2] ?? "root&stagger";
const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
});
const browser = await chromium.launch();
try {
    await server.listen();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}e2e/native-preload-diagnostic.html?${mode}`);
    await page.waitForFunction(() => window.parallelBootFixture?.state().starts.includes("notebooks"));
    await page.evaluate(() => {
        window.parallelBootFixture.release("preferences");
        window.parallelBootFixture.release("notebooks");
    });
    if (mode.includes("stagger")) {
        await page.waitForFunction(() =>
            window.parallelBootFixture.state().releasedSources.includes("notebooks")
        );
        await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.parallelBootFixture.release("notes"));
    await page.waitForFunction(() => window.parallelBootFixture.state().ready);
    await page.evaluate(() => window.parallelBootFixture.mount());
    await page
        .getByTestId("ids")
        .waitFor({ timeout: 1500 })
        .catch(() => {});
    console.log(
        JSON.stringify(
            {
                mode,
                state: await page.evaluate(() => window.parallelBootFixture.state()),
                body: await page.locator("body").innerText(),
                errors,
            },
            null,
            2
        )
    );
    await page.evaluate(() => window.parallelBootFixture.close());
} finally {
    await browser.close();
    await server.close();
}
