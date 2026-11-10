import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, RouteStore } from "portless";
import { createServer, resolveConfig } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ensureProxy } from "./proxy.js";
import { worktreePrefix } from "./worktree.js";
import { worktreeDev } from "./index.js";
import type { ViteDevServer } from "vite";

vi.mock("./proxy.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./proxy.js")>()),
    ensureProxy: vi.fn(),
}));

vi.mock("./worktree.js", () => ({ worktreePrefix: vi.fn(async () => "") }));

describe("Portless Vite plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-portless-"));
    const store = new RouteStore(join(root, "state"));
    const proxy = createProxyServer({ getRoutes: () => store.loadRoutes(), proxyPort: 1355 });
    const servers: ViteDevServer[] = [];
    let proxyPort: number;

    beforeAll(async () => {
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@example/my-app" }));
        writeFileSync(join(root, "index.html"), "<h1>Portless works</h1>");
        await new Promise<void>((resolve, reject) => {
            proxy.once("error", reject);
            proxy.listen(0, "127.0.0.1", resolve);
        });
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("Missing proxy port");
        proxyPort = address.port;
        vi.mocked(ensureProxy).mockResolvedValue({ store, port: proxyPort, tld: "localhost", tls: false });
    });

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.close()));
        vi.unstubAllEnvs();
        vi.mocked(ensureProxy).mockClear();
        vi.mocked(worktreePrefix).mockClear();
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) =>
            proxy.close((error) => (error ? reject(error) : resolve()))
        );
        rmSync(root, { recursive: true, force: true });
    });

    async function server(options: Parameters<typeof worktreeDev>[0] = {}, port = 3000) {
        const dev = await createServer({
            root,
            configFile: false,
            plugins: [worktreeDev(options)],
            server: { port, allowedHosts: ["other.localhost"] },
        });
        servers.push(dev);
        return dev;
    }

    function get(hostname: string, path = "/"): Promise<{ status: number | undefined; body: string }> {
        return new Promise((resolve, reject) => {
            const req = request(
                { host: "127.0.0.1", port: proxyPort, path, headers: { host: hostname } },
                (res) => {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk: string) => {
                        body += chunk;
                    });
                    res.on("end", () => resolve({ status: res.statusCode, body }));
                }
            );
            req.on("error", reject);
            req.end();
        });
    }

    it("serves the unscoped package hostname through Portless and unregisters on close", async () => {
        const dev = await server();
        await dev.listen();
        expect(store.loadRoutes()).toMatchObject([{ hostname: "my-app.localhost", pid: process.pid }]);
        expect(dev.httpServer?.address()).toMatchObject({ port: store.loadRoutes()[0]!.port });
        expect(dev.config.server.allowedHosts).toContain("other.localhost");
        expect(dev.resolvedUrls?.local).toEqual([
            `http://my-app.localhost:${proxyPort}/`,
            `http://localhost:${store.loadRoutes()[0]!.port}/`,
        ]);
        expect(await get("my-app.localhost")).toMatchObject({
            status: 200,
            body: expect.stringContaining("Portless works"),
        });
        expect(dev.config.server.ws).toMatchObject({
            host: "my-app.localhost",
            clientPort: proxyPort,
            protocol: "ws",
        });
        await dev.close();
        expect(store.loadRoutes()).toEqual([]);
        expect((await get("my-app.localhost")).status).toBe(404);
    });

    it("does not start a development proxy while resolving test configuration", async () => {
        const config = await resolveConfig(
            { root, configFile: false, plugins: [worktreeDev()] },
            "serve",
            "test"
        );
        expect(ensureProxy).not.toHaveBeenCalled();
        expect(config.server.origin).toBeUndefined();
    });

    it("supports an explicit app name", async () => {
        const dev = await server({ name: "dashboard" });
        await dev.listen();
        expect((await get("dashboard.localhost")).status).toBe(200);
    });

    it("keeps the configured port when free and falls back when another server occupies it", async () => {
        const blocker = createHttpServer((_req, res) => res.end("other app"));
        await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
        const address = blocker.address();
        if (!address || typeof address === "string") throw new Error("Missing blocker port");
        try {
            const occupied = await server({ name: "fallback" }, address.port);
            await occupied.listen();
            const fallbackAddress = occupied.httpServer?.address();
            expect(fallbackAddress).toMatchObject({ port: expect.any(Number) });
            expect(fallbackAddress).not.toMatchObject({ port: address.port });
            expect(occupied.resolvedUrls?.local[1]).toBe(
                `http://localhost:${(fallbackAddress as { port: number }).port}/`
            );
            expect(store.loadRoutes()).toMatchObject([
                { hostname: "fallback.localhost", port: (fallbackAddress as { port: number }).port },
            ]);
            expect((await get("fallback.localhost")).status).toBe(200);
            await occupied.close();
        } finally {
            await new Promise<void>((resolve, reject) =>
                blocker.close((error) => (error ? reject(error) : resolve()))
            );
        }
        const available = await server({ name: "preferred" }, address.port);
        await available.listen();
        expect(available.httpServer?.address()).toMatchObject({ port: address.port });
        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Portless works");
    });

    it("keeps the app suffix when automatically prefixing a worktree", async () => {
        vi.mocked(worktreePrefix).mockResolvedValueOnce("codex-feature-ui.");
        const dev = await server({ name: "web" });
        await dev.listen();
        expect((await get("codex-feature-ui.web.localhost")).status).toBe(200);
        expect(dev.config.server.origin).toBe(`http://codex-feature-ui.web.localhost:${proxyPort}`);
        expect(dev.config.server.ws).toMatchObject({ host: "codex-feature-ui.web.localhost" });
        expect(dev.config.define?.["import.meta.env.WORKTREE_DEV_ORIGIN"]).toBe(
            JSON.stringify(`http://codex-feature-ui.web.localhost:${proxyPort}`)
        );
    });

    it("proxies the Vite HMR WebSocket handshake", async () => {
        const dev = await server();
        await dev.listen();
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const req = request({
                host: "127.0.0.1",
                port: proxyPort,
                headers: {
                    host: "my-app.localhost",
                    connection: "Upgrade",
                    upgrade: "websocket",
                    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                    "sec-websocket-version": "13",
                    "sec-websocket-protocol": "vite-hmr",
                },
            });
            req.on("upgrade", (res, socket) => {
                socket.destroy();
                resolve(res.statusCode);
            });
            req.on("response", (res) => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on("error", reject);
            req.setTimeout(2000, () => req.destroy(new Error("WebSocket handshake timed out")));
            req.end();
        });
        expect(status).toBe(101);
    });

    it("does not start a proxy during build or preview config resolution", async () => {
        await resolveConfig({ root, configFile: false, plugins: [worktreeDev()] }, "build");
        await resolveConfig(
            { root, configFile: false, plugins: [worktreeDev()] },
            "serve",
            "production",
            "production",
            true
        );
        expect(ensureProxy).not.toHaveBeenCalled();
    });

    it("re-registers after a Vite restart", async () => {
        const dev = await server();
        await dev.listen();
        await dev.restart();
        expect((await get("my-app.localhost")).status).toBe(200);
        expect(store.loadRoutes()).toHaveLength(1);
    });

    it("does not take a hostname owned by another running process", async () => {
        store.addRoute("taken.localhost", 12345, process.ppid);
        try {
            const dev = await server({ name: "taken" });
            await expect(dev.listen()).rejects.toThrow("already registered");
            expect(store.loadRoutes().find((route) => route.hostname === "taken.localhost")?.pid).toBe(
                process.ppid
            );
        } finally {
            store.removeRoute("taken.localhost", process.ppid);
        }
    });

    it("rejects invalid names before starting the proxy", async () => {
        await expect(server({ name: "invalid_name" })).rejects.toThrow("Invalid hostname");
        expect(ensureProxy).not.toHaveBeenCalled();
    });

    it("supports the Portless CLI environment without registering a second route", async () => {
        vi.stubEnv("PORTLESS_URL", "https://external.localhost");
        vi.stubEnv("PORT", "0");
        const dev = await server();
        await dev.listen();
        expect(dev.config.server.origin).toBe("https://external.localhost");
        expect(dev.config.server.ws).toMatchObject({ protocol: "wss", clientPort: 443 });
        expect(ensureProxy).not.toHaveBeenCalled();
        expect(store.loadRoutes()).toEqual([]);
    });

    it("can be disabled with PORTLESS=0", async () => {
        vi.stubEnv("PORTLESS", "0");
        const dev = await server();
        expect(dev.config.server.port).toBe(3000);
        expect(ensureProxy).not.toHaveBeenCalled();
    });
});
