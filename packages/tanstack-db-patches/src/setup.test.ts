import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { findProjectRoot, mergePatches, SetupError } from "./setup.js";

const root = path.resolve("/tmp/patch-consumer");
const directory = path.join(root, "node_modules/.pnpm-config/@party-stack/tanstack-db-patches");

it("merges portable patch paths without mutating or discarding unrelated configuration", () => {
    const external = path.resolve("/another-workspace/other.patch");
    const existing = {
        "other@1.0.0": external,
        "inside@2.0.0": path.join(root, "patches/inside.patch"),
        "relative@3.0.0": "patches/relative.patch",
    };
    const before = { ...existing };
    const result = mergePatches(root, existing, directory, false);

    expect(existing).toEqual(before);
    expect(result).toEqual({
        "other@1.0.0": external,
        "inside@2.0.0": "patches/inside.patch",
        "relative@3.0.0": "patches/relative.patch",
        "@tanstack/db@1.0.0-rc.1.4":
            "node_modules/.pnpm-config/@party-stack/tanstack-db-patches/patches/@tanstack__db@1.0.0-rc.1.4.patch",
        "@tanstack/react-db@1.0.0-rc.1.4":
            "node_modules/.pnpm-config/@party-stack/tanstack-db-patches/patches/@tanstack__react-db@1.0.0-rc.1.4.patch",
    });
    expect(mergePatches(root, result, directory, false)).toEqual(result);
});

it("refuses a conflicting target patch before changing any entries", () => {
    const existing = { "@tanstack/db@1.0.0-rc.1.4": "patches/custom-db.patch" };
    expect(() => mergePatches(root, existing, directory, false)).toThrow(SetupError);
    expect(existing).toEqual({ "@tanstack/db@1.0.0-rc.1.4": "patches/custom-db.patch" });
});

it("core-only setup leaves an independently managed React patch alone", () => {
    const result = mergePatches(
        root,
        { "@tanstack/react-db@1.0.0-rc.1.4": "patches/custom-react.patch" },
        directory,
        true
    );
    expect(result["@tanstack/react-db@1.0.0-rc.1.4"]).toBe("patches/custom-react.patch");
    expect(result["@tanstack/db@1.0.0-rc.1.4"]).toBe(
        "node_modules/.pnpm-config/@party-stack/tanstack-db-patches/patches/@tanstack__db@1.0.0-rc.1.4.patch"
    );
});

it.effect("finds the workspace root when invoked inside an application", () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "patch workspace " });
        const app = path.join(workspace, "apps/example");
        const nested = path.join(app, "src/components");
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.writeFileString(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
        yield* fs.writeFileString(path.join(app, "package.json"), '{"name":"example"}');

        const canonical = yield* fs.realPath(workspace);
        expect(yield* findProjectRoot(nested)).toBe(canonical);
        expect(yield* findProjectRoot(app)).toBe(canonical);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("finds a standalone project without requiring an existing workspace file", () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "patch-project-" });
        const nested = path.join(project, "src");
        yield* fs.makeDirectory(nested);
        yield* fs.writeFileString(path.join(project, "package.json"), '{"name":"standalone"}');

        expect(yield* findProjectRoot(nested)).toBe(yield* fs.realPath(project));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("resolves a symlinked cwd to the actual workspace before comparing local package ownership", () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "patch-real-workspace-" });
        const links = yield* fs.makeTempDirectoryScoped({ prefix: "patch-workspace-links-" });
        const app = path.join(workspace, "apps/example");
        yield* fs.makeDirectory(app, { recursive: true });
        yield* fs.writeFileString(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
        yield* fs.symlink(workspace, path.join(links, "alias"));
        const canonical = yield* fs.realPath(workspace);
        expect(yield* findProjectRoot(path.join(links, "alias/apps/example"))).toBe(canonical);
        expect(yield* findProjectRoot(app)).toBe(canonical);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("reports a directory without a project instead of configuring an arbitrary ancestor", () =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "patch-no-project-" });
        const error = yield* findProjectRoot(directory).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SetupError);
        expect(error.message).toContain("Run from a pnpm project");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
