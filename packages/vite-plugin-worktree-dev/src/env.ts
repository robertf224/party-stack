import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Provision ignored env files before Vite and framework config hooks load them. */
export async function linkDevelopmentEnv(envDir: string): Promise<boolean> {
    const baseLinked = await linkEnvFile(envDir, ".env");
    const localLinked = await linkEnvFile(envDir, ".env.local");
    return baseLinked || localLinked;
}

async function linkEnvFile(envDir: string, filename: ".env" | ".env.local"): Promise<boolean> {
    if (!existsSync(envDir)) return false;
    const cwd = realpathSync(resolve(envDir));
    const target = join(cwd, filename);
    try {
        // lstat also preserves dangling symlinks, just like Studio's setup helper.
        lstatSync(target);
        return false;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const git = async (...args: string[]) =>
        (await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 3000 })).stdout;
    let worktreeRoot: string;
    let mainRoot: string;
    try {
        worktreeRoot = (await git("rev-parse", "--show-toplevel")).trim();
        const first = (await git("worktree", "list", "--porcelain", "-z")).split("\0")[0];
        if (!first?.startsWith("worktree ")) return false;
        mainRoot = first.slice("worktree ".length);
    } catch {
        // A generic plugin also supports non-Git apps and checkouts without a shared env file.
        return false;
    }
    const appPath = relative(worktreeRoot, cwd);
    if (appPath === ".." || appPath.startsWith(`..${sep}`) || isAbsolute(appPath)) return false;
    const source = join(mainRoot, appPath, filename);
    if (!existsSync(source)) return false;
    if (!statSync(source).isFile())
        throw new Error(`[worktree-dev] Shared env source must be a file: ${source}`);

    try {
        await git("check-ignore", "--quiet", "--", target);
    } catch {
        throw new Error(`[worktree-dev] Refusing to link ${target}: the target must be gitignored.`);
    }
    try {
        symlinkSync(source, target, "file");
    } catch (error) {
        // A concurrent Vite startup may have already provisioned the same file.
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
    }
    return true;
}
