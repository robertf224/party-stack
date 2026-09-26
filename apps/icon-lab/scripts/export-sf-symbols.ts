import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.SF_SYMBOLS_CLI ?? "/Applications/SF Symbols.app/Contents/Executables/sfsymbols";
const outputDir = path.resolve(process.argv[2] ?? path.join(root, "temp", "sf-symbols"));
const names = JSON.parse(
    await readFile(path.join(root, "public", "icon-sets", "sfsymbols.json"), "utf8")
) as string[];

if (process.platform !== "darwin") {
    throw new Error(
        "Apple's official SF Symbols export CLI requires macOS. Run this script on a Mac with the SF Symbols app installed."
    );
}

await access(cli);
await mkdir(outputDir, { recursive: true });

const concurrency = 8;
let completed = 0;
for (let start = 0; start < names.length; start += concurrency) {
    await Promise.all(
        names.slice(start, start + concurrency).map(async (name) => {
            await execute(cli, [
                "export",
                name,
                "--format",
                "png",
                "--output",
                path.join(outputDir, `${name}.png`),
                "--weight",
                "regular",
                "--point-size",
                "64",
                "--image-scale",
                "1",
                "--rendering-mode",
                "monochrome",
                "--color",
                "black",
            ]);
            completed += 1;
        })
    );
    if (start % (concurrency * 25) === 0) {
        console.log(`Exported ${completed}/${names.length} SF Symbols…`);
    }
}

console.log(`Exported ${completed} licensed local PNG previews to ${outputDir}`);
