import path from "node:path";
import { Console, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class SetupError extends Schema.TaggedError<SetupError>()("SetupError", {
    message: Schema.String,
}) {}

export const targets = [
    {
        name: "@tanstack/db",
        version: "1.0.0-rc.1.4",
        file: "@tanstack__db@1.0.0-rc.1.4.patch",
        checks: [
            ["dist/esm/query/compiler/order-by.js", /supportsOrderedWindow/],
            ["dist/cjs/query/compiler/order-by.cjs", /supportsOrderedWindow/],
        ],
    },
    {
        name: "@tanstack/react-db",
        version: "1.0.0-rc.1.4",
        file: "@tanstack__react-db@1.0.0-rc.1.4.patch",
        checks: [
            ["dist/esm/useLiveQuery.js", /startSync:\s*!forSuspense\s*[,}]/],
            ["dist/cjs/useLiveQuery.cjs", /startSync:\s*!forSuspense\s*[,}]/],
            ["dist/esm/useLiveSuspenseQuery.js", /status === `cleaned-up`/],
        ],
    },
] as const;
const Package = Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString });
const Mapping = Schema.Record(Schema.String, Schema.String);
const ConfigDependencies = Schema.Record(
    Schema.String,
    Schema.Union([
        Schema.String,
        Schema.Struct({ integrity: Schema.String, tarball: Schema.optional(Schema.String) }),
    ])
);
interface InstalledNode {
    readonly path?: string;
    readonly dependencies?: Record<string, InstalledNode>;
    readonly devDependencies?: Record<string, InstalledNode>;
    readonly optionalDependencies?: Record<string, InstalledNode>;
}
const InstalledNodeSchema: Schema.Codec<InstalledNode> = Schema.suspend(() =>
    Schema.Struct({
        path: Schema.optional(Schema.String),
        dependencies: Schema.optional(Schema.Record(Schema.String, InstalledNodeSchema)),
        devDependencies: Schema.optional(Schema.Record(Schema.String, InstalledNodeSchema)),
        optionalDependencies: Schema.optional(Schema.Record(Schema.String, InstalledNodeSchema)),
    })
);
const within = (root: string, value: string) => {
    const relative = path.relative(root, value);
    return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
};
const portable = (root: string, value: string) =>
    (path.isAbsolute(value) && within(root, value) ? path.relative(root, value) : value)
        .split(path.sep)
        .join("/");
const attempt = <A>(work: () => A) =>
    Effect.try({
        try: work,
        catch: (cause) => (cause instanceof SetupError ? cause : new SetupError({ message: String(cause) })),
    });

export function mergePatches(
    root: string,
    existing: Record<string, string>,
    directory: string,
    coreOnly: boolean
) {
    const merged = Object.fromEntries(
        Object.entries(existing).map(([key, value]) => [key, portable(root, value)])
    );
    for (const target of coreOnly ? targets.slice(0, 1) : targets) {
        const key = `${target.name}@${target.version}`;
        const absolute = path.join(directory, "patches", target.file);
        const previous = existing[key];
        if (previous !== undefined && path.resolve(root, previous) !== absolute)
            throw new SetupError({
                message: `${key} already has another patch. Resolve that patchedDependencies entry before running setup; it will not be overwritten.`,
            });
        merged[key] = portable(root, absolute);
    }
    return merged;
}

export const findProjectRoot = Effect.fnUntraced(function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    let current = yield* fs.realPath(path.resolve(cwd)),
        project: string | undefined;
    for (;;) {
        if (yield* fs.exists(path.join(current, "pnpm-workspace.yaml"))) return current;
        if (!project && (yield* fs.exists(path.join(current, "package.json")))) project = current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    if (project) return project;
    return yield* new SetupError({ message: "Run from a pnpm project, or pass --cwd with its directory." });
});

const pnpm = Effect.fnUntraced(function* (root: string, args: readonly string[], capture = false) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
        Effect.gen(function* () {
            const child = yield* spawner.spawn(
                ChildProcess.make("pnpm", args, {
                    cwd: root,
                    stdin: "inherit",
                    stdout: capture ? "pipe" : "inherit",
                    stderr: "inherit",
                })
            );
            const output = capture ? yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString) : "";
            const code = yield* child.exitCode;
            if (code !== 0)
                return yield* new SetupError({ message: `pnpm ${args[0]} failed with exit code ${code}.` });
            return output.trim();
        })
    );
});
const configuration = Effect.fnUntraced(function* <A>(root: string, key: string, codec: Schema.Codec<A>) {
    const output = yield* pnpm(root, ["config", "get", key, "--json", "--location=project"], true);
    if (!output || output === "undefined" || output === "null") return undefined;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(codec))(output);
});
const ensurePnpm = Effect.fnUntraced(function* (root: string) {
    const version = yield* pnpm(root, ["--version"], true);
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    if (major !== 10 || minor < 34 || (minor === 34 && patch < 6))
        return yield* new SetupError({
            message: `This CLI is tested with pnpm 10.34.6 and supports pnpm 10.34.6 or newer 10.x; found ${version}.`,
        });
});
export interface Options {
    readonly cwd: string;
    readonly packageDir: string;
    readonly coreOnly: boolean;
    readonly local: boolean;
}
const selected = (coreOnly: boolean) => (coreOnly ? targets.slice(0, 1) : targets);
const patchDirectory = (root: string, options: Options) => {
    if (options.local) {
        if (!within(root, path.resolve(options.packageDir)))
            throw new SetupError({
                message:
                    "--local requires this package to be checked out or unpacked inside the target workspace. Do not register a temporary dlx/cache directory.",
            });
        return options.packageDir;
    }
    return path.join(root, "node_modules", ".pnpm-config", "@party-stack", "tanstack-db-patches");
};

export const check = Effect.fn("TanstackPatches.check")(function* (options: Options) {
    const root = yield* findProjectRoot(options.cwd);
    yield* ensurePnpm(root);
    const fs = yield* FileSystem.FileSystem;
    const packageDir = yield* fs.realPath(options.packageDir);
    const directory = yield* attempt(() => patchDirectory(root, { ...options, packageDir }));
    const configured = (yield* configuration(root, "patchedDependencies", Mapping)) ?? {};
    const desired = yield* attempt(() => mergePatches(root, configured, directory, options.coreOnly));
    for (const target of selected(options.coreOnly)) {
        const key = `${target.name}@${target.version}`;
        if (!configured[key] || path.resolve(root, configured[key]) !== path.resolve(root, desired[key]!))
            return yield* new SetupError({
                message: `Missing native pnpm patch configuration for ${key}. Run setup.`,
            });
        if (!(yield* fs.exists(path.join(directory, "patches", target.file))))
            return yield* new SetupError({
                message: `The configured patch file for ${key} is unavailable. Run setup.`,
            });
    }
    const output = yield* pnpm(
        root,
        [
            "list",
            ...selected(options.coreOnly).map((target) => target.name),
            "--json",
            "--depth",
            "Infinity",
            "--recursive",
        ],
        true
    );
    const projects = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(InstalledNodeSchema))
    )(output);
    const found = new Map<string, Set<string>>();
    const visit = Effect.fnUntraced(function* (
        node: InstalledNode
    ): Effect.fn.Return<
        void,
        SetupError | import("effect").PlatformError.PlatformError | import("effect").Schema.SchemaError,
        FileSystem.FileSystem
    > {
        for (const group of [node.dependencies, node.devDependencies, node.optionalDependencies])
            for (const [name, child] of Object.entries(group ?? {})) {
                const target = selected(options.coreOnly).find((item) => item.name === name);
                if (target && child.path) {
                    const previous = found.get(name) ?? new Set<string>();
                    if (!previous.has(child.path)) {
                        previous.add(child.path);
                        found.set(name, previous);
                        const pkg = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Package))(
                            yield* fs.readFileString(path.join(child.path, "package.json"))
                        );
                        if (pkg.version !== target.version)
                            return yield* new SetupError({
                                message: `Unsupported installed ${name}@${pkg.version}; this patch release supports ${target.version}.`,
                            });
                        for (const [file, pattern] of target.checks)
                            if (!pattern.test(yield* fs.readFileString(path.join(child.path, file))))
                                return yield* new SetupError({
                                    message: `${name}@${pkg.version} is installed without the expected patch (${file}). Run pnpm install.`,
                                });
                        if (
                            name === "@tanstack/react-db" &&
                            (yield* fs.readFileString(
                                path.join(child.path, "dist/esm/useLiveSuspenseQuery.js")
                            )).includes("setTimeout(release, 0)")
                        )
                            return yield* new SetupError({
                                message: "The React DB initial-error retry fix is missing. Run pnpm install.",
                            });
                    }
                }
                yield* visit(child);
            }
    });
    for (const project of projects) yield* visit(project);
    for (const target of selected(options.coreOnly))
        if (!found.has(target.name))
            return yield* new SetupError({
                message: `${target.name}@${target.version} is not installed in this workspace.`,
            });
    yield* Console.log("TanStack DB patches are configured and installed.");
});

export const setup = Effect.fn("TanstackPatches.setup")(function* (
    options: Options & { readonly install: boolean }
) {
    const root = yield* findProjectRoot(options.cwd);
    yield* ensurePnpm(root);
    const fs = yield* FileSystem.FileSystem;
    const packageDir = yield* fs.realPath(options.packageDir);
    const directory = yield* attempt(() => patchDirectory(root, { ...options, packageDir }));
    const previous = (yield* configuration(root, "patchedDependencies", Mapping)) ?? {};
    const merged = yield* attempt(() => mergePatches(root, previous, directory, options.coreOnly));
    // Force object settings into project YAML even when the project previously
    // had only .npmrc. Credentials and unrelated INI settings remain untouched.
    const manifest = path.join(root, "pnpm-workspace.yaml");
    if (!(yield* fs.exists(manifest))) yield* fs.writeFileString(manifest, "");
    if (!options.local) {
        const own = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Package))(
            yield* fs.readFileString(path.join(options.packageDir, "package.json"))
        );
        const deps = (yield* configuration(root, "configDependencies", ConfigDependencies)) ?? {};
        const current = deps[own.name];
        const integrity = typeof current === "string" ? current : current?.integrity;
        if (!integrity?.startsWith(`${own.version}+`))
            yield* pnpm(root, ["add", "--config", `${own.name}@${own.version}`]);
    }
    for (const target of selected(options.coreOnly))
        if (!(yield* fs.exists(path.join(directory, "patches", target.file))))
            return yield* new SetupError({ message: `Package patch file ${target.file} is unavailable.` });
    yield* pnpm(root, [
        "config",
        "set",
        "--location=project",
        "--json",
        "patchedDependencies",
        JSON.stringify(merged),
    ]);
    if (options.install) {
        yield* pnpm(root, ["install", "--no-frozen-lockfile"]);
        yield* check(options);
    } else yield* Console.log("Registered native pnpm patches. Run pnpm install to apply them.");
});
