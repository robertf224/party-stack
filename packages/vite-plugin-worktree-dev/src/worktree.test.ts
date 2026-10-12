import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { worktreePrefix } from "./worktree.js";

describe("worktree naming", () => {
    const fixture = mkdtempSync(join(tmpdir(), "worktree-dev-naming-"));
    const main = join(fixture, "main");
    const named = join(fixture, "named");
    const detached = join(fixture, "detached");
    const otherDetached = join(fixture, "other-detached");
    const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    beforeAll(() => {
        mkdirSync(main);
        git(main, "init", "--initial-branch=main");
        git(
            main,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--allow-empty",
            "-m",
            "fixture"
        );
        git(main, "worktree", "add", "-b", "codex/Feature_UI", named);
        git(main, "worktree", "add", "--detach", detached);
        git(main, "worktree", "add", "--detach", otherDetached);
        mkdirSync(join(detached, "apps", "web"), { recursive: true });
    });

    afterAll(() => rmSync(fixture, { recursive: true, force: true }));

    it("leaves the main checkout unprefixed", async () => {
        expect(await worktreePrefix(main)).toBe("");
    });

    it("sanitizes a linked worktree branch into a single DNS label", async () => {
        expect(await worktreePrefix(named)).toBe("codex-feature-ui.");
    });

    it("uses a canonical root hash for detached HEAD, regardless of the app directory", async () => {
        const hash = createHash("sha256").update(realpathSync(detached)).digest("hex").slice(0, 10);
        expect(await worktreePrefix(detached)).toBe(`wt-${hash}.`);
        expect(await worktreePrefix(join(detached, "apps", "web"))).toBe(`wt-${hash}.`);
        expect(await worktreePrefix(otherDetached)).not.toBe(`wt-${hash}.`);
    });

    it("keeps the detached ID across commits and symlinked paths", async () => {
        const before = await worktreePrefix(detached);
        git(
            detached,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--allow-empty",
            "-m",
            "next commit"
        );
        const alias = join(fixture, "alias");
        symlinkSync(detached, alias, "dir");
        expect(await worktreePrefix(detached)).toBe(before);
        expect(await worktreePrefix(alias)).toBe(before);
    });

    it("bounds long branches to one valid DNS label", async () => {
        git(named, "branch", "-m", `codex/${"long-branch-".repeat(8)}`);
        const prefix = await worktreePrefix(named);
        expect(prefix).toMatch(/^[a-z0-9-]+\.$/);
        expect(prefix.length).toBeLessThanOrEqual(64);
    });

    it("leaves non-Git apps unprefixed", async () => {
        expect(await worktreePrefix(fixture)).toBe("");
    });
});
