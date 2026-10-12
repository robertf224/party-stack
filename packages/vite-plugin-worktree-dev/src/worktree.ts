import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Linked worktrees get one DNS label; main checkouts and non-Git apps get none. */
export async function worktreePrefix(root: string): Promise<string> {
    const cwd = resolve(root);
    const git = async (...args: string[]) =>
        (await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 3000 })).stdout.trim();

    let worktreeRoot: string;
    try {
        const [gitDir, commonDir, topLevel] = (
            await git(
                "rev-parse",
                "--path-format=absolute",
                "--git-dir",
                "--git-common-dir",
                "--show-toplevel"
            )
        ).split("\n");
        if (!gitDir || !commonDir || !topLevel) return "";
        if (realpathSync(gitDir) === realpathSync(commonDir)) return "";
        worktreeRoot = realpathSync(topLevel);
    } catch {
        return "";
    }

    let branch = "";
    try {
        branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
    } catch {
        // Detached HEAD is normal for agent-created worktrees.
    }

    const label = branch
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (label) {
        // Keep the complete branch name in one label so *.app.localhost covers it.
        return `${label.length <= 63 ? label : `${label.slice(0, 52).replace(/-+$/g, "")}-${hash(branch)}`}.`;
    }
    return `wt-${hash(worktreeRoot)}.`;
}

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
