import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import { generateLive } from "../generate/live.js";
import { generateTypes } from "../generate/types.js";
import { blogOntology } from "./blog.js";

const outDir = resolve(process.cwd(), "src/examples/generated");
mkdirSync(outDir, { recursive: true });

const typesFilePath = join(outDir, "blog.types.ts");
const liveFilePath = join(outDir, "blog.live.ts");
const header = "// Auto-generated file - do not edit manually\n\n";

const typesOutput = generateTypes(blogOntology, { linkMapTypeName: "BlogLinkMap" });
const liveOutput = generateLive(blogOntology, {
    ontologyImportPath: "../blog.js",
    ontologyExportName: "blogOntology",
    ontologyTypesImportPath: "./blog.types.js",
    linkMapTypeName: "BlogLinkMap",
    outputTypeName: "BlogLiveOntology",
    outputFactoryName: "createBlogLiveOntology",
});

const prettierConfig = await resolveConfig(outDir);

const formatAndWrite = async (filePath: string, content: string) => {
    const formatted = await format(header + content, {
        ...prettierConfig,
        filepath: filePath,
    });
    writeFileSync(filePath, formatted, "utf-8");
};

await Promise.all([formatAndWrite(typesFilePath, typesOutput), formatAndWrite(liveFilePath, liveOutput)]);

console.log(`Generated blog example types written to: ${typesFilePath}`);
console.log(`Generated blog example live helpers written to: ${liveFilePath}`);
