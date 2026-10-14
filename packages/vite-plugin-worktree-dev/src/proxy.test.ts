import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ensureProxy } from "./proxy.js";

const execFileAsync = promisify(execFile);

afterEach(() => vi.unstubAllEnvs());

it("starts the installed Portless daemon and reuses it without a global CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portless-daemon-test-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No probe port");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    vi.stubEnv("PORTLESS_STATE_DIR", dir);
    vi.stubEnv("PORTLESS_PORT", String(address.port));
    vi.stubEnv("PORTLESS_LAN", "0");
    vi.stubEnv("PORTLESS_SYNC_HOSTS", "0");
    vi.stubEnv("npm_command", "exec");
    vi.stubEnv("PNPM_SCRIPT_SRC_DIR", dir);
    vi.stubEnv("npm_lifecycle_event", "");
    try {
        // Reproduce an app launched via pnpm exec with no direct Portless dependency.
        writeFileSync(join(dir, "index.html"), "<h1>Ready</h1>");
        const entry = new URL("../lib/index.js", import.meta.url).href;
        const viteEntry = import.meta.resolve("vite");
        const { stdout } = await execFileAsync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { worktreeDev } from ${JSON.stringify(entry)};
                 import { createServer } from ${JSON.stringify(viteEntry)};
                 import { request } from "node:http";
                 const dev = await createServer({ configFile: false, plugins: [worktreeDev({ name: "ready" })] });
                 try {
                     await dev.listen();
                     const status = await new Promise((resolve, reject) => {
                         const req = request({ host: "127.0.0.1", port: ${address.port},
                             headers: { host: "ready.localhost:${address.port}" }
                         }, response => {
                             response.resume();
                             response.on("end", () => resolve(response.statusCode));
                         });
                         req.on("error", reject);
                         req.end();
                     });
                     console.log(JSON.stringify({ status }));
                 } finally { await dev.close(); }`,
            ],
            {
                cwd: dir,
                env: process.env,
                timeout: 20_000,
            }
        );
        expect(stdout).toContain('"status":200');
        const proxy = await ensureProxy();
        expect(proxy).toMatchObject({ port: address.port, tld: "localhost", tls: false });
        expect(proxy.store.dir).toBe(dir);
        expect(proxy.store.loadRoutes()).toEqual([]);
        const pid = readFileSync(join(dir, "proxy.pid"), "utf8");
        expect(await ensureProxy()).toMatchObject({ port: address.port, tls: false });
        expect(readFileSync(join(dir, "proxy.pid"), "utf8")).toBe(pid);
    } finally {
        const cli = join(dirname(fileURLToPath(import.meta.resolve("portless"))), "cli.js");
        const env: NodeJS.ProcessEnv = { ...process.env, PORTLESS_STATE_DIR: dir };
        delete env.npm_command;
        delete env.PNPM_SCRIPT_SRC_DIR;
        await execFileAsync(process.execPath, [cli, "proxy", "stop", "--port", String(address.port)], {
            env,
            timeout: 10_000,
        });
        rmSync(dir, { recursive: true, force: true });
    }
}, 30_000);
