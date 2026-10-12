import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveUserHome, RouteStore } from "portless";

const execFileAsync = promisify(execFile);

function readState(dir: string) {
    try {
        const port = Number(readFileSync(join(dir, "proxy.port"), "utf8").trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
        const tld = existsSync(join(dir, "proxy.tld"))
            ? readFileSync(join(dir, "proxy.tld"), "utf8").trim()
            : "localhost";
        return { port, tld, tls: existsSync(join(dir, "proxy.tls")) };
    } catch {
        return undefined;
    }
}

function isRunning(port: number): Promise<boolean> {
    // Portless also accepts plain HTTP on its TLS port for health checks.
    return new Promise((resolve) => {
        const req = request({ host: "127.0.0.1", port, method: "HEAD", path: "/" }, (res) => {
            res.resume();
            resolve(res.headers["x-portless"] === "1");
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => req.destroy());
        req.end();
    });
}

/** Start the transitive dependency's CLI daemon; share its normal route store. */
export async function ensureProxy() {
    const dir = process.env.PORTLESS_STATE_DIR || join(resolveUserHome(), ".portless");
    let state = readState(dir);
    if (!state || !(await isRunning(state.port))) {
        const port = Number(process.env.PORTLESS_PORT ?? 1355);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new Error("[portless] PORTLESS_PORT must be an unprivileged port between 1024 and 65535.");
        }
        const cli = join(dirname(fileURLToPath(import.meta.resolve("portless"))), "cli.js");
        const env: NodeJS.ProcessEnv = { ...process.env, PORTLESS_STATE_DIR: dir };
        // This is the resolved, installed dependency. Parent runner hints from
        // `pnpm exec vp dev` would otherwise misidentify it as an ephemeral install.
        delete env.npm_command;
        delete env.PNPM_SCRIPT_SRC_DIR;
        try {
            await execFileAsync(
                process.execPath,
                [
                    cli,
                    "proxy",
                    "start",
                    "--port",
                    String(port),
                    "--no-tls",
                    "--tld",
                    "localhost",
                    "--skip-trust",
                ],
                { timeout: 30_000, env }
            );
        } catch (error) {
            // Another app may have started the shared daemon at the same time.
            state = readState(dir);
            if (!state || !(await isRunning(state.port))) {
                throw new Error("[portless] Could not start the local proxy.", { cause: error });
            }
        }
        state = readState(dir);
    }
    if (!state || !(await isRunning(state.port))) {
        throw new Error("[portless] The local proxy did not become ready.");
    }
    return { ...state, store: new RouteStore(dir) };
}

/** The daemon reloads its route cache asynchronously after a route-store write. */
export async function waitForRoute(
    proxy: Awaited<ReturnType<typeof ensureProxy>>,
    hostname: string,
    path: string
) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const ready = await new Promise<boolean>((resolve) => {
            const req = (proxy.tls ? httpsRequest : request)(
                {
                    host: "127.0.0.1",
                    port: proxy.port,
                    method: "HEAD",
                    path,
                    headers: { host: `${hostname}:${proxy.port}` },
                    // The local Portless CA may not be trusted by Node's certificate store.
                    rejectUnauthorized: false,
                    agent: false,
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode === 204);
                }
            );
            req.on("error", () => resolve(false));
            req.setTimeout(500, () => req.destroy());
            req.end();
        });
        if (ready) return;
        await setTimeout(50);
    }
    throw new Error(`[portless] The proxy did not activate the route for ${hostname}.`);
}
