import { execFileSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadEnv, resolveConfig } from "vite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { linkDevelopmentEnv } from "./env.js";
import { worktreeDev } from "./index.js";

describe("shared development env", () => {
    const fixture = mkdtempSync(join(tmpdir(), "worktree-env-"));
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    let counter = 0;
    let source: string;
    let target: string;
    let app: string;
    const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: main, stdio: ["ignore", "pipe", "pipe"] });

    beforeAll(() => {
        mkdirSync(main);
        git("init", "--initial-branch=main");
        writeFileSync(join(main, ".gitignore"), ".env\n.env.local\n");
        git("add", ".gitignore");
        git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "fixture"
        );
        git("worktree", "add", "--detach", linked);
    });

    beforeEach(() => {
        vi.stubEnv("VITEST", "");
        vi.stubEnv("PORTLESS", "0");
        const path = join("apps", `app-${counter++}`);
        app = join(linked, path);
        mkdirSync(join(main, path), { recursive: true });
        mkdirSync(app, { recursive: true });
        source = join(main, path, ".env.local");
        target = join(app, ".env.local");
        writeFileSync(source, "VITE_WORKTREE_ENV_FIXTURE=shared\nPRIVATE_WORKTREE_ENV_FIXTURE=private\n");
    });

    afterEach(() => vi.unstubAllEnvs());
    afterAll(() => rmSync(fixture, { recursive: true, force: true }));

    it("links the matching app's primary-checkout env file and reflects shared edits", async () => {
        expect(await linkDevelopmentEnv(app)).toBe(true);
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
        expect(realpathSync(target)).toBe(realpathSync(source));
        writeFileSync(source, "VITE_WORKTREE_ENV_FIXTURE=updated\n");
        expect(readFileSync(target, "utf8")).toContain("updated");
        expect(await linkDevelopmentEnv(app)).toBe(false);
    });

    it("links both files before Vite loads them, retaining .env.local precedence", async () => {
        const baseSource = join(main, relative(linked, app), ".env");
        writeFileSync(baseSource, "VITE_WORKTREE_ENV_FIXTURE=base\nVITE_BASE_ENV_ONLY=base-only\n");
        const config = await resolveConfig(
            { root: app, configFile: false, plugins: [worktreeDev()] },
            "serve"
        );
        expect(realpathSync(join(app, ".env"))).toBe(realpathSync(baseSource));
        expect(realpathSync(target)).toBe(realpathSync(source));
        expect(config.env.VITE_WORKTREE_ENV_FIXTURE).toBe("shared");
        expect(config.env.VITE_BASE_ENV_ONLY).toBe("base-only");
    });

    it.each([".env", ".env.local"])(
        "preserves existing %s while linking the other file",
        async (filename) => {
            const sourceDir = join(main, relative(linked, app));
            writeFileSync(join(sourceDir, ".env"), "base\n");
            writeFileSync(join(app, filename), "local override\n");
            expect(await linkDevelopmentEnv(app)).toBe(true);
            expect(readFileSync(join(app, filename), "utf8")).toBe("local override\n");
            const other = filename === ".env" ? ".env.local" : ".env";
            expect(realpathSync(join(app, other))).toBe(realpathSync(join(sourceDir, other)));
        }
    );

    it("links .env when .env.local is absent in the primary checkout", async () => {
        rmSync(source);
        const baseSource = join(main, relative(linked, app), ".env");
        writeFileSync(baseSource, "base\n");
        expect(await linkDevelopmentEnv(app)).toBe(true);
        expect(realpathSync(join(app, ".env"))).toBe(realpathSync(baseSource));
        expect(existsSync(target)).toBe(false);
    });

    it("preserves a worktree-local file", async () => {
        writeFileSync(target, "local override\n");
        expect(await linkDevelopmentEnv(app)).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("local override\n");
        expect(lstatSync(target).isSymbolicLink()).toBe(false);
    });

    it("preserves existing and dangling symlinks", async () => {
        const destination = join(app, "missing-env");
        symlinkSync(destination, target, "file");
        expect(await linkDevelopmentEnv(app)).toBe(false);
        expect(readlinkSync(target)).toBe(destination);
        writeFileSync(destination, "local\n");
        expect(await linkDevelopmentEnv(app)).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("local\n");
    });

    it("skips absent primary-checkout env files", async () => {
        rmSync(source);
        expect(await linkDevelopmentEnv(app)).toBe(false);
        expect(existsSync(target)).toBe(false);
    });

    it("refuses to link a target that is not gitignored", async () => {
        writeFileSync(join(linked, ".gitignore"), `.env\n.env.local\n!/${relative(linked, target)}\n`);
        await expect(linkDevelopmentEnv(app)).rejects.toThrow("target must be gitignored");
        expect(existsSync(target)).toBe(false);
    });

    it("handles concurrent startups without overwriting either target", async () => {
        const results = await Promise.all([linkDevelopmentEnv(app), linkDevelopmentEnv(app)]);
        expect(results.sort()).toEqual([false, true]);
        expect(realpathSync(target)).toBe(realpathSync(source));
    });

    it("links before Vite and framework plugins load env, even with PORTLESS=0", async () => {
        let frameworkValue: string | undefined;
        const config = await resolveConfig(
            {
                root: app,
                configFile: false,
                plugins: [
                    {
                        name: "framework-reader",
                        config: (_config, env) => {
                            frameworkValue = loadEnv(env.mode, app).VITE_WORKTREE_ENV_FIXTURE;
                        },
                    },
                    worktreeDev(),
                ],
            },
            "serve"
        );
        expect(frameworkValue).toBe("shared");
        expect(config.env.VITE_WORKTREE_ENV_FIXTURE).toBe("shared");
        expect(config.env.PRIVATE_WORKTREE_ENV_FIXTURE).toBeUndefined();
    });

    it.each(["build", "preview", "test", "vitest", "metadata", "disabled", "envDir-disabled"])(
        "does not link during %s",
        async (mode) => {
            if (mode === "vitest") vi.stubEnv("VITEST", "true");
            if (mode === "metadata") vi.stubEnv("VP_RESOLVING_CONFIG_METADATA", "1");
            writeFileSync(join(main, relative(linked, app), ".env"), "VITE_BASE_ENV_ONLY=base\n");
            await resolveConfig(
                {
                    root: app,
                    configFile: false,
                    envDir: mode === "envDir-disabled" ? false : undefined,
                    plugins: [worktreeDev({ env: mode === "disabled" ? false : undefined })],
                },
                mode === "build" ? "build" : "serve",
                mode === "test" ? "test" : "development",
                "development",
                mode === "preview"
            );
            expect(existsSync(target)).toBe(false);
            expect(existsSync(join(app, ".env"))).toBe(false);
        }
    );

    it("respects a custom Vite envDir", async () => {
        const sourceDir = join(main, relative(linked, app), "config");
        const envDir = join(app, "config");
        mkdirSync(sourceDir);
        mkdirSync(envDir);
        writeFileSync(join(sourceDir, ".env.local"), "VITE_WORKTREE_ENV_FIXTURE=custom\n");
        const config = await resolveConfig(
            { root: app, configFile: false, envDir: "config", plugins: [worktreeDev()] },
            "serve"
        );
        expect(config.env.VITE_WORKTREE_ENV_FIXTURE).toBe("custom");
        expect(existsSync(target)).toBe(false);
        expect(realpathSync(join(envDir, ".env.local"))).toBe(realpathSync(join(sourceDir, ".env.local")));
    });
});
