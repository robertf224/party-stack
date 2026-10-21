import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, "../..");
const temporary = await mkdtemp(join(tmpdir(), "tables-review-"));
try {
    const output = join(temporary, "review.js");
    const result = spawnSync(
        "pnpm",
        [
            "exec",
            "esbuild",
            join(folder, "review.ts"),
            "--bundle",
            "--format=iife",
            "--global-name=TablesReview",
            "--platform=browser",
            "--minify",
            `--outfile=${output}`,
        ],
        {
            cwd: root,
            stdio: "inherit",
            env: { ...process.env, NODE_PATH: join(root, "packages/ontology-storage/node_modules") },
        }
    );
    if (result.status !== 0) throw new Error("Review bundle failed");
    const sources = {};
    async function include(path) {
        sources[path] = await readFile(join(root, path), "utf8");
    }
    async function directory(path) {
        for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
            const child = `${path}/${entry.name}`;
            if (entry.isDirectory()) await directory(child);
            else if (entry.name.endsWith(".ts")) await include(child);
        }
    }
    for (const name of ["effect-tables", "effect-tables-indexeddb", "effect-tables-sql"]) {
        await directory(`packages/${name}/src`);
        for (const file of ["package.json", "README.md", "vite.config.ts", "tsconfig.json"])
            await include(`packages/${name}/${file}`);
    }
    for (const file of [
        "AGENTS.md",
        "package.json",
        "packages/build-config/src/effect.ts",
        "packages/build-config/src/effect.test.ts",
        "packages/build-config/README.md",
        "packages/build-config/package.json",
        "packages/build-config/tsconfig/effect-library.json",
        ".vscode/extensions.json",
        ".vscode/settings.json",
        ".agents/skills/README.md",
        ".agents/skills/effect-ts/SKILL.md",
        ".agents/skills/effect-v3-to-v4/SKILL.md",
        ".changeset/tables-infrastructure.md",
        "specs/2026-10-19-effect-tables-replica/README.md",
        "specs/2026-10-19-effect-tables-replica/schema-migrations.md",
        "packages/indexeddb-ontology-storage/benchmarks/2026-10-19-chromium.md",
    ])
        await include(file);
    const script =
        `${await readFile(output, "utf8")}\nTablesReview.mountReview(${JSON.stringify(sources)});`.replaceAll(
            "</script",
            "<\\/script"
        );
    const html = (await readFile(join(folder, "review.template.html"), "utf8")).replace(
        "<!-- REVIEW_SCRIPT -->",
        () => `<script>${script}</script>`
    );
    const destination = join(folder, "review-generated");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "index.html"), html);
    console.log(
        `Built ${join(destination, "index.html")} (${Buffer.byteLength(html)} bytes; ${Object.keys(sources).length} source files)`
    );
} finally {
    await rm(temporary, { recursive: true, force: true });
}
