import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
    getIconPaths,
    IconNames as BlueprintLibraryIconNames,
    IconSize,
    type IconName as BlueprintIconName,
} from "@blueprintjs/icons";
import { buildLucideSvg } from "@lucide/icons/build";
import { lucideDynamicIconImports } from "@lucide/icons/dynamic";
import { icons as materialSymbols } from "@iconify-json/material-symbols";
import { IconNames, type IconName } from "@party-stack/icons";
import { BlueprintIconNames } from "@party-stack/icons-blueprint";
import { ExpoSymbolNames, MaterialSymbolArchiveNames } from "@party-stack/icons-expo";
import { LucideIconNames } from "@party-stack/icons-lucide";
import { SalesforceLightningIconNames } from "@party-stack/icons-salesforce-lightning";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { CatalogFile, CatalogIcon, IconProvider } from "../src/shared/types";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const archivesDir = path.join(publicDir, "icon-sets");
const dataDir = path.join(root, "temp", "data");
const catalogOnly = process.argv.includes("--catalog-only");
const sfSymbolsOnly = process.argv.includes("--sf-symbols-only");

interface Source {
    package: string;
    version: string;
    archiveUrl: string;
    homepage: string;
    license: string;
    note?: string;
}

type Sources = Record<IconProvider, Source>;

interface ArchiveBuild {
    provider: Exclude<IconProvider, "sfsymbols">;
    files: Zippable;
    icons: CatalogIcon[];
}

function humanize(name: string): string {
    return name
        .replaceAll(/[._/-]+/g, " ")
        .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .trim();
}

function safeName(name: string): string {
    return name.replaceAll(/[^a-zA-Z0-9._/-]+/g, "_");
}

function npmTarball(packageName: string, version: string): string {
    const leaf = packageName.split("/").at(-1)!;
    return `https://registry.npmjs.org/${packageName}/-/${leaf}-${version}.tgz`;
}

function packageRoot(packageName: string): string {
    let current: string;
    try {
        current = path.dirname(require.resolve(packageName));
    } catch {
        current = path.dirname(require.resolve(`${packageName}/package.json`));
    }
    while (current !== path.dirname(current)) {
        if (existsSync(path.join(current, "package.json"))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error(`Could not locate package root for ${packageName}`);
}

function packageVersion(packageName: string): string {
    return (
        JSON.parse(readFileSync(path.join(packageRoot(packageName), "package.json"), "utf8")) as {
            version: string;
        }
    ).version;
}

function svgFromBlueprintPaths(paths: string[]): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${paths
        .map((d) => `<path d="${d}" fill="currentColor"/>`)
        .join("")}</svg>`;
}

function svgFromIconify(name: string): string {
    const icon = materialSymbols.icons[name]!;
    const width = icon.width ?? materialSymbols.width ?? 24;
    const height = icon.height ?? materialSymbols.height ?? 24;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="currentColor">${icon.body}</svg>`;
}

function materialNameForAndroid(androidName: string): string | undefined {
    const base = androidName.replaceAll("_", "-");
    const candidates = [base, `${base}-outline`, `${base}-rounded`, `${base}-sharp`];
    return (
        candidates.find((candidate) => candidate in materialSymbols.icons) ??
        Object.keys(materialSymbols.icons).find((candidate) => candidate.startsWith(`${base}-`))
    );
}

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) {
            result.push(...(await listFilesRecursive(path.join(dir, entry.name), relative)));
        } else {
            result.push(relative);
        }
    }
    return result;
}

function conceptMaps() {
    const blueprint = new Map<string, IconName[]>();
    const lucide = new Map<string, IconName[]>();
    const material = new Map<string, IconName[]>();
    const salesforce = new Map<string, IconName[]>();
    const sfsymbols = new Map<string, IconName[]>();
    const add = (map: Map<string, IconName[]>, name: string, concept: IconName) => {
        const concepts = map.get(name) ?? [];
        concepts.push(concept);
        map.set(name, concepts);
    };

    for (const concept of IconNames) {
        const blueprintName = BlueprintIconNames[concept];
        if (blueprintName) {
            add(blueprint, blueprintName, concept);
        }
        add(lucide, LucideIconNames[concept], concept);
        const materialName =
            MaterialSymbolArchiveNames[concept as keyof typeof MaterialSymbolArchiveNames] ??
            materialNameForAndroid(ExpoSymbolNames[concept].android);
        if (materialName) {
            add(material, materialName, concept);
        }
        const salesforceName = SalesforceLightningIconNames[concept];
        if (salesforceName) {
            add(salesforce, salesforceName, concept);
        }
        const sfSymbolName = ExpoSymbolNames[concept].ios;
        if (sfSymbolName) {
            add(sfsymbols, sfSymbolName, concept);
        }
    }

    return { blueprint, lucide, material, salesforce, sfsymbols };
}

async function buildBlueprint(concepts: ReturnType<typeof conceptMaps>): Promise<ArchiveBuild> {
    const provider = "blueprint" as const;
    const files: Zippable = {};
    const icons: CatalogIcon[] = [];
    const names = [...new Set(Object.values(BlueprintLibraryIconNames) as string[])].sort();

    for (const name of names) {
        const mappedConcepts = concepts.blueprint.get(name);
        const assetPath = `${safeName(name)}.svg`;
        files[assetPath] = strToU8(
            svgFromBlueprintPaths(getIconPaths(name as BlueprintIconName, IconSize.LARGE))
        );
        icons.push({
            id: `${provider}:${name}`,
            provider,
            name,
            concept: mappedConcepts?.[0],
            concepts: mappedConcepts,
            asset: { archive: `${provider}.zip`, path: assetPath, format: "svg" },
            labels: [humanize(name), "blueprint icon", "foundry icon"],
        });
    }
    return { provider, files, icons };
}

async function buildLucide(concepts: ReturnType<typeof conceptMaps>): Promise<ArchiveBuild> {
    const provider = "lucide" as const;
    const files: Zippable = {};
    const icons: CatalogIcon[] = [];
    const names = Object.keys(lucideDynamicIconImports).sort();

    let index = 0;
    for (const name of names) {
        const mappedConcepts = concepts.lucide.get(name);
        const module = await lucideDynamicIconImports[name as keyof typeof lucideDynamicIconImports]();
        const assetPath = `${safeName(name)}.svg`;
        files[assetPath] = strToU8(buildLucideSvg(module.default));
        icons.push({
            id: `${provider}:${name}`,
            provider,
            name,
            concept: mappedConcepts?.[0],
            concepts: mappedConcepts,
            asset: { archive: `${provider}.zip`, path: assetPath, format: "svg" },
            labels: [humanize(name), "lucide icon"],
        });
        index += 1;
        if (index % 500 === 0) {
            console.log(`  lucide ${index}/${names.length}`);
        }
    }
    return { provider, files, icons };
}

async function buildMaterial(concepts: ReturnType<typeof conceptMaps>): Promise<ArchiveBuild> {
    const provider = "material" as const;
    const files: Zippable = {};
    const icons: CatalogIcon[] = [];
    const names = Object.keys(materialSymbols.icons).sort();

    for (const name of names) {
        const mappedConcepts = concepts.material.get(name);
        const assetPath = `${safeName(name)}.svg`;
        files[assetPath] = strToU8(svgFromIconify(name));
        icons.push({
            id: `${provider}:${name}`,
            provider,
            name,
            concept: mappedConcepts?.[0],
            concepts: mappedConcepts,
            asset: { archive: `${provider}.zip`, path: assetPath, format: "svg" },
            labels: [humanize(name), "material symbol"],
        });
    }
    return { provider, files, icons };
}

async function buildSalesforce(concepts: ReturnType<typeof conceptMaps>): Promise<ArchiveBuild> {
    const provider = "salesforce" as const;
    const files: Zippable = {};
    const icons: CatalogIcon[] = [];
    const packageDir = packageRoot("@salesforce-ux/icons");
    const sourceDir = path.join(packageDir, "dist/salesforce-lightning-design-system-icons");
    const metadata = new Map<string, string[]>();

    for (const category of ["action", "custom", "doctype", "standard", "utility"]) {
        const metadataPath = path.join(packageDir, `dist/${category}-icons-metadata.json`);
        if (!(await fileExists(metadataPath))) {
            continue;
        }
        const categoryMetadata = await readJson<Record<string, { synonyms?: string[] }>>(metadataPath);
        for (const [name, value] of Object.entries(categoryMetadata)) {
            metadata.set(`${category}/${name}`, value.synonyms ?? []);
        }
    }

    const svgFiles = (await listFilesRecursive(sourceDir)).filter(
        (relative) => relative.endsWith(".svg") && !relative.includes("-sprite/")
    );
    for (const relative of svgFiles.sort()) {
        const category = relative.split("/")[0]!;
        if (!["action", "custom", "doctype", "standard", "utility"].includes(category)) {
            continue;
        }
        const name = path.posix.basename(relative, ".svg");
        const qualifiedName = `${category}/${name}`;
        const mappedConcepts = concepts.salesforce.get(qualifiedName);
        const assetPath = `${qualifiedName}.svg`;
        files[assetPath] = new Uint8Array(await readFile(path.join(sourceDir, relative)));
        icons.push({
            id: `${provider}:${qualifiedName}`,
            provider,
            name: qualifiedName,
            concept: mappedConcepts?.[0],
            concepts: mappedConcepts,
            asset: { archive: `${provider}.zip`, path: assetPath, format: "svg" },
            labels: [
                humanize(name),
                ...(metadata.get(qualifiedName) ?? []).map(humanize),
                `salesforce ${category} icon`,
            ],
        });
    }
    return { provider, files, icons };
}

async function buildSfSymbols(concepts: ReturnType<typeof conceptMaps>): Promise<CatalogIcon[]> {
    const typesRoot = packageRoot("sf-symbols-typescript");
    const declaration = await readFile(path.join(typesRoot, "dist/index.d.ts"), "utf8");
    const names = [
        ...new Set([...declaration.matchAll(/^\s*(?:=|\|)\s*'([^']+)'/gm)].map((match) => match[1]!)),
    ].sort();

    return names.map((name) => {
        const mappedConcepts = concepts.sfsymbols.get(name);
        return {
            id: `sfsymbols:${name}`,
            provider: "sfsymbols" as const,
            name,
            concept: mappedConcepts?.[0],
            concepts: mappedConcepts,
            textOnly: true,
            labels: [humanize(name), "sf symbol", "apple symbol"],
        };
    });
}

async function attachLocalSfSymbolAssets(
    icons: CatalogIcon[]
): Promise<{ icons: CatalogIcon[]; bytes: number; assetCount: number }> {
    const archiveName = "sfsymbols.local.zip";
    const archivePath = path.join(dataDir, archiveName);
    const assetDir = process.env.SF_SYMBOLS_ASSET_DIR;
    if (!assetDir) {
        await rm(archivePath, { force: true });
        return { icons, bytes: 0, assetCount: 0 };
    }

    const relativeFiles = await listFilesRecursive(assetDir);
    const sourceByName = new Map<string, string>();
    for (const extension of ["png", "svg"] as const) {
        for (const relative of relativeFiles) {
            if (path.extname(relative).toLowerCase() !== `.${extension}`) {
                continue;
            }
            const name = path.basename(relative, path.extname(relative));
            if (!sourceByName.has(name)) {
                sourceByName.set(name, relative);
            }
        }
    }

    const files: Zippable = {};
    let assetCount = 0;
    const withAssets = await Promise.all(
        icons.map(async (icon): Promise<CatalogIcon> => {
            const relative = sourceByName.get(icon.name);
            if (!relative) {
                return icon;
            }
            const extension = path.extname(relative).slice(1).toLowerCase() as "png" | "svg";
            const assetPath = `${safeName(icon.name)}.${extension}`;
            files[assetPath] = new Uint8Array(await readFile(path.join(assetDir, relative)));
            assetCount += 1;
            return {
                ...icon,
                textOnly: undefined,
                asset: {
                    archive: archiveName,
                    path: assetPath,
                    format: extension,
                },
            };
        })
    );

    if (assetCount === 0) {
        throw new Error(
            `SF_SYMBOLS_ASSET_DIR=${assetDir} contains no PNG/SVG files matching SF Symbol names`
        );
    }
    await writeFile(archivePath, zipSync(files, { level: 6 }));
    return {
        icons: withAssets,
        bytes: (await stat(archivePath)).size,
        assetCount,
    };
}

async function buildCatalogFromSnapshot(
    provider: Exclude<IconProvider, "sfsymbols">,
    concepts: Map<string, IconName[]>
): Promise<CatalogIcon[]> {
    const archiveName = `${provider}.zip`;
    const archive = unzipSync(new Uint8Array(await readFile(path.join(archivesDir, archiveName))));
    return Object.keys(archive)
        .filter((assetPath) => assetPath.endsWith(".svg"))
        .sort()
        .map((assetPath) => {
            const name = assetPath.slice(0, -".svg".length);
            const mappedConcepts = concepts.get(name);
            const humanName = humanize(path.posix.basename(name));
            const labels =
                provider === "blueprint"
                    ? [humanName, "blueprint icon", "foundry icon"]
                    : provider === "lucide"
                      ? [humanName, "lucide icon"]
                      : provider === "material"
                        ? [humanName, "material symbol"]
                        : [humanName, `salesforce ${name.split("/")[0]} icon`];
            return {
                id: `${provider}:${name}`,
                provider,
                name,
                concept: mappedConcepts?.[0],
                concepts: mappedConcepts,
                asset: {
                    archive: archiveName,
                    path: assetPath,
                    format: "svg" as const,
                },
                labels,
            };
        });
}

async function main(): Promise<void> {
    await mkdir(archivesDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await rm(path.join(publicDir, "icons"), { recursive: true, force: true });

    const concepts = conceptMaps();
    if (sfSymbolsOnly) {
        const sfSymbols = await buildSfSymbols(concepts);
        await writeFile(
            path.join(archivesDir, "sfsymbols.json"),
            `${JSON.stringify(sfSymbols.map(({ name }) => name))}\n`
        );
        console.log(`Wrote ${sfSymbols.length} SF Symbol names.`);
        return;
    }

    const configuredSources = await readJson<Sources>(path.join(root, "icon-sources.json"));
    const effectiveSources = catalogOnly
        ? await readJson<Sources>(path.join(archivesDir, "sources.json"))
        : (Object.fromEntries(
              Object.entries(configuredSources).map(([provider, source]) => {
                  const version = packageVersion(source.package);
                  return [
                      provider,
                      {
                          ...source,
                          version,
                          archiveUrl: npmTarball(source.package, version),
                      },
                  ];
              })
          ) as Sources);

    if (catalogOnly) {
        const providers = ["blueprint", "lucide", "material", "salesforce"] as const;
        const icons = (
            await Promise.all(
                providers.map((provider) => buildCatalogFromSnapshot(provider, concepts[provider]))
            )
        ).flat();
        const sfSymbolNames = await readJson<string[]>(path.join(archivesDir, "sfsymbols.json"));
        const sfSymbols = await attachLocalSfSymbolAssets(
            sfSymbolNames.map((name) => {
                const mappedConcepts = concepts.sfsymbols.get(name);
                return {
                    id: `sfsymbols:${name}`,
                    provider: "sfsymbols" as const,
                    name,
                    concept: mappedConcepts?.[0],
                    concepts: mappedConcepts,
                    textOnly: true,
                    labels: [humanize(name), "sf symbol", "apple symbol"],
                };
            })
        );
        icons.push(...sfSymbols.icons);
        const archives: CatalogFile["archives"] = {};
        for (const provider of providers) {
            const source = effectiveSources[provider];
            archives[provider] = {
                path: `/icon-sets/${provider}.zip`,
                iconCount: icons.filter((icon) => icon.provider === provider).length,
                bytes: (await stat(path.join(archivesDir, `${provider}.zip`))).size,
                source: source.archiveUrl,
                version: source.version,
                license: source.license,
            };
        }
        const sfSource = effectiveSources.sfsymbols;
        archives.sfsymbols = {
            path: sfSymbols.assetCount > 0 ? "sfsymbols.local.zip" : "",
            iconCount: sfSymbolNames.length,
            bytes: sfSymbols.bytes,
            source: sfSource.archiveUrl,
            version: sfSource.version,
            license: sfSource.license,
        };
        const catalog: CatalogFile = {
            providers: ["blueprint", "lucide", "material", "salesforce", "sfsymbols"],
            concepts: [...IconNames],
            icons,
            archives,
        };
        await writeFile(path.join(dataDir, "catalog.json"), JSON.stringify(catalog));
        console.log(
            `Wrote ${icons.length} catalog entries from committed snapshots (${sfSymbols.assetCount} local SF Symbol images).`
        );
        return;
    }

    console.log("Building provider snapshots…");
    const builds = [
        await buildBlueprint(concepts),
        await buildLucide(concepts),
        await buildMaterial(concepts),
        await buildSalesforce(concepts),
    ];
    const sfSymbolNames = await buildSfSymbols(concepts);
    await writeFile(
        path.join(archivesDir, "sfsymbols.json"),
        `${JSON.stringify(sfSymbolNames.map(({ name }) => name))}\n`
    );
    const sfSymbols = await attachLocalSfSymbolAssets(sfSymbolNames);

    const archives: CatalogFile["archives"] = {};
    const icons: CatalogIcon[] = [];

    for (const build of builds) {
        const archivePath = path.join(archivesDir, `${build.provider}.zip`);
        if (!catalogOnly) {
            await writeFile(archivePath, zipSync(build.files, { level: 9 }));
        }
        const source = effectiveSources[build.provider];
        archives[build.provider] = {
            path: `/icon-sets/${build.provider}.zip`,
            iconCount: build.icons.length,
            bytes: (await stat(archivePath)).size,
            source: source.archiveUrl,
            version: source.version,
            license: source.license,
        };
        icons.push(...build.icons);
        console.log(
            `  ${build.provider.padEnd(12)} ${String(build.icons.length).padStart(5)} icons → ${((await stat(archivePath)).size / 1024).toFixed(0)} KiB`
        );
    }

    icons.push(...sfSymbols.icons);
    const sfSource = effectiveSources.sfsymbols;
    archives.sfsymbols = {
        path: sfSymbols.assetCount > 0 ? "sfsymbols.local.zip" : "",
        iconCount: sfSymbolNames.length,
        bytes: sfSymbols.bytes,
        source: sfSource.archiveUrl,
        version: sfSource.version,
        license: sfSource.license,
    };

    const catalog: CatalogFile = {
        providers: ["blueprint", "lucide", "material", "salesforce", "sfsymbols"],
        concepts: [...IconNames],
        icons,
        archives,
    };
    await writeFile(path.join(dataDir, "catalog.json"), JSON.stringify(catalog));
    if (!catalogOnly) {
        await writeFile(path.join(archivesDir, "sources.json"), JSON.stringify(effectiveSources, null, 2));
        await writeFile(
            path.join(root, "icon-sources.json"),
            `${JSON.stringify(effectiveSources, null, 4)}\n`
        );
    }

    console.log(
        `  sfsymbols    ${String(sfSymbolNames.length).padStart(5)} names · ${sfSymbols.assetCount} local images (not redistributed)`
    );
    console.log(`Wrote ${icons.length} catalog entries and ${builds.length} compact archives.`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
