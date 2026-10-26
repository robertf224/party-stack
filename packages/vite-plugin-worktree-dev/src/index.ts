import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUrl, parseHostname } from "portless";
import { linkDevelopmentEnv } from "./env.js";
import { ensureProxy, waitForRoute } from "./proxy.js";
import { worktreePrefix } from "./worktree.js";
import type { Plugin } from "vite";

export interface WorktreeDevOptions {
    /** Hostname before the TLD. Defaults to the root package name without its scope. */
    name?: string;
    /** Link missing .env and .env.local files from the primary checkout during dev. Enabled by default. */
    env?: boolean;
}

/** Named local URLs with no CLI wrapper or separate Portless install. */
export function worktreeDev(options: WorktreeDevOptions = {}): Plugin {
    let proxy: Awaited<ReturnType<typeof ensureProxy>>;
    let hostname: string;
    let origin: string;
    let cleanup: (() => void) | undefined;
    const externallyManaged = Boolean(process.env.PORTLESS_URL);

    return {
        name: "party-stack:worktree-dev",
        enforce: "pre",
        apply: (_config, env) => env.command === "serve" && !env.isPreview,
        async config(config, env) {
            if (process.env.VP_RESOLVING_CONFIG_METADATA || env.mode === "test") return;
            const root = config.root ?? process.cwd();
            if (
                options.env !== false &&
                config.envDir !== false &&
                env.mode !== "test" &&
                !process.env.VITEST
            ) {
                if (await linkDevelopmentEnv(resolve(root, config.envDir ?? "."))) {
                    console.info("[worktree-dev] Linked missing env files to the shared dev env files.");
                }
            }
            if (["0", "false"].includes(process.env.PORTLESS ?? "")) return;
            if (config.server?.middlewareMode) {
                throw new Error(
                    "[portless] A standalone Vite dev server is required (middlewareMode is unsupported)."
                );
            }
            let url: URL;
            if (externallyManaged) {
                url = new URL(process.env.PORTLESS_URL!);
            } else {
                const name = options.name ?? packageName(root);
                const prefix = await worktreePrefix(root);
                // Validate before starting a daemon or writing state.
                parseHostname(`${prefix}${name}`);
                proxy = await ensureProxy();
                hostname = parseHostname(`${prefix}${name}`, proxy.tld);
                url = new URL(formatUrl(hostname, proxy.port, proxy.tls));
            }
            origin = url.origin;
            return {
                define: { "import.meta.env.WORKTREE_DEV_ORIGIN": JSON.stringify(origin) },
                server: {
                    host: "127.0.0.1",
                    port: externallyManaged ? Number(process.env.PORT) : (config.server?.port ?? 5173),
                    strictPort: externallyManaged,
                    // The proxy speaks HTTP to Vite even when the public URL is HTTPS.
                    https: undefined,
                    origin,
                    allowedHosts:
                        config.server?.allowedHosts === true
                            ? true
                            : [...(config.server?.allowedHosts ?? []), url.hostname],
                    ...(config.server?.ws === false
                        ? {}
                        : {
                              ws: {
                                  ...(typeof config.server?.ws === "object" ? config.server.ws : {}),
                                  port: 0,
                                  host: url.hostname,
                                  protocol: url.protocol === "https:" ? "wss" : "ws",
                                  clientPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
                              },
                          }),
                },
            };
        },
        configureServer(server) {
            if (!origin) return;
            server.printUrls = () => {
                const [worktree, local] = server.resolvedUrls?.local ?? [];
                if (worktree) server.config.logger.info(`  ➜  Worktree: ${worktree}`);
                if (local) server.config.logger.info(`  ➜  Local:    ${local}`);
            };
            if (server.config.server.https) {
                throw new Error("[portless] Configure HTTPS on the Portless proxy, not on the Vite backend.");
            }
            const readyPath = `/.portless/vite-ready/${randomUUID()}`;
            server.middlewares.use((req, res, next) => {
                if (req.method === "HEAD" && req.url === readyPath) {
                    res.statusCode = 204;
                    res.end();
                } else {
                    next();
                }
            });
            const listen = server.listen.bind(server);
            server.listen = async (...args) => {
                await listen(...args);
                const address = server.httpServer?.address();
                if (!address || typeof address === "string") {
                    throw new Error("[portless] Vite did not bind a TCP port.");
                }
                if (!externallyManaged) {
                    try {
                        proxy.store.addRoute(hostname, address.port, process.pid);
                    } catch (error) {
                        await server.close();
                        throw error;
                    }
                    cleanup = () => {
                        proxy.store.removeRoute(hostname, process.pid);
                        process.off("exit", onExit);
                        cleanup = undefined;
                    };
                    const onExit = () => {
                        try {
                            cleanup?.();
                        } catch {
                            // Portless prunes stale PID-owned routes after an abrupt exit.
                        }
                    };
                    process.once("exit", onExit);
                    server.httpServer?.once("close", () => cleanup?.());
                    try {
                        await waitForRoute(proxy, hostname, readyPath);
                    } catch (error) {
                        await server.close();
                        throw error;
                    }
                }
                server.resolvedUrls = {
                    local: [
                        `${origin}${server.config.base}`,
                        `http://localhost:${address.port}${server.config.base}`,
                    ],
                    network: [],
                };
                return server;
            };
        },
        closeServer() {
            cleanup?.();
        },
    };
}

function packageName(root: string): string {
    const path = resolve(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: string };
    if (!pkg.name) {
        throw new Error(`[portless] ${path} needs a package name, or pass worktreeDev({ name: "my-app" }).`);
    }
    return pkg.name.replace(/^@[^/]+\//, "");
}
