import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
assert.deepEqual(
    manifest.dependencies ?? {},
    {},
    "The config package must not need runtime dependencies before ordinary installation"
);
const name = manifest.name;
const version = manifest.version;
const targets = { "@tanstack/db": "1.0.0-rc.1.4", "@tanstack/react-db": "1.0.0-rc.1.4" };
const artifacts = process.env.PARTY_PATCHES_DISTRIBUTION_DIR
    ? path.resolve(process.env.PARTY_PATCHES_DISTRIBUTION_DIR)
    : await mkdtemp(path.join(tmpdir(), "party-tanstack-patches-distribution-"));
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(path.join(artifacts, "consumers-"));
for (let ancestor = scratch; ; ancestor = path.dirname(ancestor)) {
    assert.equal(
        await stat(path.join(ancestor, "pnpm-workspace.yaml")).then(
            () => true,
            () => false
        ),
        false,
        "Place distribution artifacts outside existing pnpm workspaces so the npmrc-only fixture cannot select another workspace owner"
    );
    if (path.dirname(ancestor) === ancestor) break;
}
const commands = [];
const requests = [];
const results = [];
let sequence = 0;

async function run(command, args, cwd, { failure = false } = {}) {
    const serial = ++sequence;
    const record = { command, args, cwd, exitCode: null };
    commands.push(record);
    const child = spawn(command, args, {
        cwd,
        env: { ...process.env, CI: "true" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => {
        stdout += value;
    });
    child.stderr.on("data", (value) => {
        stderr += value;
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
    try {
        record.exitCode = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) =>
                signal ? reject(new Error(`${command} ended with ${signal}`)) : resolve(code)
            );
        });
    } finally {
        clearTimeout(timeout);
        await writeFile(
            path.join(artifacts, `${String(serial).padStart(2, "0")}.log`),
            `${command} ${args.join(" ")}\n${stdout}\n${stderr}`
        );
    }
    if (!failure)
        assert.equal(
            record.exitCode,
            0,
            `${command} ${args.join(" ")} failed; see ${artifacts}/${String(serial).padStart(2, "0")}.log`
        );
    return { stdout, stderr, code: record.exitCode };
}

async function packed(directory) {
    const before = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    await run("pnpm", ["pack", "--pack-destination", artifacts], directory);
    const filename = `${before.name.replace(/^@/, "").replaceAll("/", "-")}-${before.version}.tgz`;
    const filenamePath = path.join(artifacts, filename);
    const bytes = await readFile(filenamePath);
    return {
        manifest: before,
        filename,
        filenamePath,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        shasum: createHash("sha1").update(bytes).digest("hex"),
    };
}

async function config(cwd, key) {
    const value = (await run("pnpm", ["config", "get", key, "--json"], cwd)).stdout.trim();
    return value === "undefined" || value === "" ? undefined : JSON.parse(value);
}

function blob(bytes) {
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function verifyPatchedPackage(consumer, packageName) {
    const installed = await realpath(path.join(consumer, "node_modules", packageName));
    assert.equal(
        JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")).version,
        targets[packageName]
    );
    const patch = await readFile(
        path.join(unpacked, "patches", `${packageName.replace("/", "__")}@${targets[packageName]}.patch`),
        "utf8"
    );
    let checked = 0;
    for (const entry of patch.split("diff --git ").slice(1)) {
        const file = /^a\/(\S+) b\//.exec(entry)?.[1];
        const expected = /index [a-f0-9]+\.\.([a-f0-9]+)/.exec(entry)?.[1];
        assert.ok(file && expected, "Patch entries must carry target file hashes");
        assert.ok(
            blob(await readFile(path.join(installed, file))).startsWith(expected),
            `${packageName}/${file} does not contain the packaged patch`
        );
        checked++;
    }
    assert.ok(checked > 0);
    return { packageName, filesVerified: checked, installed };
}

async function verifyConsumer(consumer, coreOnly, { unrelatedPatch = true } = {}) {
    const patches = await config(consumer, "patchedDependencies");
    if (unrelatedPatch)
        assert.equal(
            await realpath(path.resolve(consumer, patches["@fixture/untouched@1.0.0"])),
            await realpath(path.join(consumer, "patches/fixture.patch"))
        );
    else assert.equal(patches["@fixture/untouched@1.0.0"], undefined);
    const packages = [];
    for (const packageName of Object.keys(targets)) {
        if (coreOnly && packageName === "@tanstack/react-db") {
            assert.equal(patches[`${packageName}@${targets[packageName]}`], undefined);
            continue;
        }
        assert.equal(typeof patches[`${packageName}@${targets[packageName]}`], "string");
        packages.push(await verifyPatchedPackage(consumer, packageName));
    }
    const require = createRequire(path.join(consumer, "package.json"));
    assert.equal(
        require("@fixture/untouched"),
        unrelatedPatch ? "kept" : "original",
        "Unrelated dependency behavior must survive setup"
    );
    if (!coreOnly) {
        const reactEntry = require.resolve("@tanstack/react-db");
        const fromReact = createRequire(reactEntry).resolve("@tanstack/db");
        assert.equal(
            await realpath(require.resolve("@tanstack/db")),
            await realpath(fromReact),
            "React DB must use the same core DB identity"
        );
    }
    assert.equal(
        await stat(path.join(consumer, ".pnpmfile.cjs")).then(
            () => true,
            () => false
        ),
        false,
        "Setup must not require a pnpmfile loader"
    );
    return { patches, packages };
}

const fixtureDir = path.join(scratch, "fixture-package");
await mkdir(fixtureDir);
await writeFile(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
        name: "@fixture/untouched",
        version: "1.0.0",
        main: "index.cjs",
        packageManager: "pnpm@10.34.6",
    })
);
await writeFile(path.join(fixtureDir, "index.cjs"), 'module.exports = "original";\n');
const fixture = await packed(fixtureDir);
const helper = await packed(packageDir);
const unpacked = path.join(scratch, "unpacked-helper");
await mkdir(unpacked);
await run("tar", ["-xzf", helper.filenamePath, "-C", unpacked, "--strip-components=1"], scratch);
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["tanstack-db-patches"];
assert.ok(bin, "The packed helper must expose the tanstack-db-patches CLI");
const executable = path.join(unpacked, bin);
await stat(executable);
const registryPackages = new Map([
    [name, helper],
    [fixture.manifest.name, fixture],
]);
let registry;
const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        const pathname = decodeURIComponent(url.pathname);
        requests.push({ method: request.method, pathname });
        for (const [packageName, value] of registryPackages) {
            if (pathname === `/${packageName}`) {
                const data = {
                    ...value.manifest,
                    dist: {
                        tarball: `${registry}/${packageName}/-/${value.filename}`,
                        integrity: value.integrity,
                        shasum: value.shasum,
                    },
                };
                response.setHeader("content-type", "application/json");
                response.end(
                    JSON.stringify({
                        name: packageName,
                        "dist-tags": { latest: data.version },
                        versions: { [data.version]: data },
                    })
                );
                return;
            }
            if (pathname === `/${packageName}/-/${value.filename}`) {
                response.setHeader("content-type", "application/octet-stream");
                await pipeline(createReadStream(value.filenamePath), response);
                return;
            }
        }
        response.statusCode = 404;
        response.end("Unknown fixture package");
    } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
    }
});

async function consumer(id, coreOnly, { nativeConfig = true } = {}) {
    const cwd = path.join(scratch, id);
    await mkdir(path.join(cwd, "patches"), { recursive: true });
    await writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify(
            {
                name: id,
                version: "1.0.0",
                packageManager: "pnpm@10.34.6",
                private: true,
                dependencies: {
                    "@fixture/untouched": "1.0.0",
                    "@tanstack/db": targets["@tanstack/db"],
                    ...(coreOnly
                        ? {}
                        : { "@tanstack/react-db": targets["@tanstack/react-db"], react: "19.3.0" }),
                    typescript: "7.0.2",
                },
            },
            null,
            2
        )
    );
    await writeFile(
        path.join(cwd, ".npmrc"),
        `registry=https://registry.npmjs.org/\n@party-stack:registry=${registry}\n@fixture:registry=${registry}\nstore-dir=${path.join(artifacts, "store")}\nstrict-peer-dependencies=false\n`
    );
    if (nativeConfig) {
        await writeFile(
            path.join(cwd, "pnpm-workspace.yaml"),
            'packages: []\npatchedDependencies:\n  "@fixture/untouched@1.0.0": patches/fixture.patch\n'
        );
        await writeFile(
            path.join(cwd, "patches/fixture.patch"),
            'diff --git a/index.cjs b/index.cjs\n--- a/index.cjs\n+++ b/index.cjs\n@@ -1 +1 @@\n-module.exports = "original";\n+module.exports = "kept";\n'
        );
    }
    return cwd;
}

try {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    registry = `http://127.0.0.1:${server.address().port}`;
    await run(process.execPath, [executable, "--help"], scratch);
    for (const mode of ["react", "core-only", "local"]) {
        const coreOnly = mode === "core-only";
        const nativeConfig = mode !== "local";
        const cwd = await consumer(`${mode}-consumer`, coreOnly, { nativeConfig });
        const npmrc = await readFile(path.join(cwd, ".npmrc"), "utf8");
        if (!nativeConfig)
            assert.equal(
                await stat(path.join(cwd, "pnpm-workspace.yaml")).then(
                    () => true,
                    () => false
                ),
                false
            );
        const flags = coreOnly ? ["--core-only"] : mode === "local" ? ["--local"] : [];
        let command = "pnpm";
        let prefix = ["dlx", `${name}@${version}`];
        if (mode === "local") {
            const vendor = path.join(cwd, "vendor/tanstack-db-patches");
            await cp(unpacked, vendor, { recursive: true });
            const alias = path.join(scratch, "local-project-alias");
            await symlink(cwd, alias, "dir");
            flags.push("--cwd", alias);
            command = process.execPath;
            prefix = [path.join(vendor, bin)];
        }
        await run(command, [...prefix, "setup", ...flags], cwd);
        const first = await verifyConsumer(cwd, coreOnly, { unrelatedPatch: nativeConfig });
        assert.equal(
            await readFile(path.join(cwd, ".npmrc"), "utf8"),
            npmrc,
            "Setup must preserve .npmrc instead of encoding object configuration in INI"
        );
        const configuration = await config(cwd, "configDependencies");
        if (mode === "local")
            assert.equal(configuration?.[name], undefined, "Local setup must not add a registry dependency");
        else {
            const own = configuration[name];
            assert.equal(
                typeof own === "string" ? own : own?.integrity,
                `${version}+${helper.integrity}`,
                "Registry setup must pin its own exact version and integrity"
            );
        }
        await run(command, [...prefix, "check", ...flags], cwd);
        const lock = await readFile(path.join(cwd, "pnpm-lock.yaml"), "utf8");
        const workspace = await readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8");
        assert.equal(
            workspace.includes(await realpath(cwd)),
            false,
            "Saved patch paths must remain portable rather than embed this temporary workspace path"
        );
        await run(command, [...prefix, "setup", ...flags], cwd);
        assert.equal(
            await readFile(path.join(cwd, "pnpm-lock.yaml"), "utf8"),
            lock,
            "Repeated setup must not change the lockfile"
        );
        assert.equal(
            await readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8"),
            workspace,
            "Repeated setup must not change workspace configuration"
        );
        await rm(path.join(cwd, "node_modules"), { recursive: true, force: true });
        await run("pnpm", ["install", "--frozen-lockfile"], cwd);
        const reinstalled = await verifyConsumer(cwd, coreOnly, { unrelatedPatch: nativeConfig });
        assert.equal(await readFile(path.join(cwd, ".npmrc"), "utf8"), npmrc);
        results.push({
            mode,
            initialConfig: nativeConfig ? "yaml" : "npmrc-only",
            first,
            reinstalled,
            configuration,
            idempotent: true,
            frozenReinstall: true,
            npmrcPreserved: true,
        });
    }
    const outside = await consumer("outside-package-consumer", true);
    const unchanged = await readFile(path.join(outside, "pnpm-workspace.yaml"), "utf8");
    const refused = await run(
        process.execPath,
        [executable, "setup", "--local", "--no-install", "--cwd", outside, "--core-only"],
        outside,
        { failure: true }
    );
    assert.notEqual(
        refused.code,
        0,
        "A package outside the workspace must not become a durable local patch source"
    );
    assert.match(
        refused.stdout + refused.stderr,
        /inside the target workspace|temporary dlx\/cache directory/
    );
    assert.equal(await readFile(path.join(outside, "pnpm-workspace.yaml"), "utf8"), unchanged);
    results.push({ mode: "outside-workspace", rejected: true, preserved: true });
    const conflict = await consumer("conflicting-consumer", true);
    await writeFile(path.join(conflict, "conflict.patch"), "existing patch must remain untouched\n");
    await run(
        "pnpm",
        [
            "config",
            "set",
            "patchedDependencies",
            JSON.stringify({ "@tanstack/db@1.0.0-rc.1.4": "conflict.patch" }),
            "--json",
            "--location=project",
        ],
        conflict
    );
    const vendor = path.join(conflict, "vendor/tanstack-db-patches");
    await cp(unpacked, vendor, { recursive: true });
    const rejected = await run(
        process.execPath,
        [path.join(vendor, bin), "setup", "--local", "--no-install", "--cwd", conflict, "--core-only"],
        conflict,
        { failure: true }
    );
    assert.notEqual(rejected.code, 0, "A conflicting existing patch must be rejected");
    assert.match(rejected.stdout + rejected.stderr, /@tanstack\/db@1\.0\.0-rc\.1\.4/);
    assert.match(rejected.stdout + rejected.stderr, /conflict|existing patch|already.*patch/i);
    assert.equal(
        await realpath(
            path.resolve(
                conflict,
                (await config(conflict, "patchedDependencies"))["@tanstack/db@1.0.0-rc.1.4"]
            )
        ),
        await realpath(path.join(conflict, "conflict.patch"))
    );
    assert.equal(
        await readFile(path.join(conflict, "conflict.patch"), "utf8"),
        "existing patch must remain untouched\n"
    );
    results.push({ mode: "conflict", rejected: true, preserved: true });
    console.log(`Distribution verification passed. Artifacts: ${artifacts}`);
} finally {
    await new Promise((resolve) => server.close(resolve));
    await writeFile(
        path.join(artifacts, "report.json"),
        JSON.stringify({ package: `${name}@${version}`, commands, requests, results }, null, 2)
    );
    await rm(scratch, { recursive: true, force: true });
}
