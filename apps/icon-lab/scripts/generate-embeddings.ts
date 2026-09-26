import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { AutoTokenizer, CLIPTextModelWithProjection, env } from "@xenova/transformers";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";
import type {
    CatalogFile,
    CatalogIcon,
    DraftMapping,
    DraftMappingsFile,
    EmbeddingIndexFile,
    IconProvider,
    MappingAuditFile,
    MappingPairScore,
} from "../src/shared/types";
import { cosineSimilarity, l2Normalize } from "../src/shared/math";

env.allowLocalModels = false;
env.useBrowserCache = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const generatedDataDir = path.join(root, "temp", "data");
const archivesDir = path.join(root, "public", "icon-sets");
const tmpDir = path.join(root, "temp", "embedding-work");
const MODEL = "Xenova/clip-vit-base-patch32";
const EMBEDDING_DESCRIPTION = `${MODEL}+16x16-visual-descriptor`;
const TEXT_BATCH = 128;
const IMAGE_BATCH = 128;
const VISUAL_DIMS = 256;
const TEXT_WEIGHT = 0.85;
const VISUAL_WEIGHT = 0.5;
const PROVIDERS: IconProvider[] = ["blueprint", "lucide", "material", "salesforce", "sfsymbols"];

function tensorRows(tensor: { data: Float32Array | number[] }, rowCount: number): number[][] {
    const data = tensor.data as Float32Array;
    const dims = data.length / rowCount;
    return Array.from({ length: rowCount }, (_, row) =>
        l2Normalize(Array.from(data.subarray(row * dims, (row + 1) * dims)))
    );
}

function svgToPng(svg: string, size = 224): Uint8Array {
    let normalized = svg.trim();
    if (!normalized.includes("xmlns")) {
        normalized = normalized.replace("<svg", `<svg xmlns="http://www.w3.org/2000/svg"`);
    }
    normalized = normalized
        .replace(/\swidth="[^"]*"/g, "")
        .replace(/\sheight="[^"]*"/g, "")
        .replace("<svg", `<svg width="${size}" height="${size}"`);
    normalized = normalized.replace(
        /<svg([^>]*)>/,
        `<svg$1><rect width="100%" height="100%" fill="#f8fafc"/>`
    );
    return new Resvg(normalized, {
        fitTo: { mode: "width", value: size },
        background: "white",
    })
        .render()
        .asPng();
}

async function visualDescriptor(bytes: Uint8Array, format: "svg" | "png", dims: number): Promise<number[]> {
    const source = format === "svg" ? svgToPng(strFromU8(bytes), 64) : bytes;
    const pixels = await sharp(source)
        .flatten({ background: "#ffffff" })
        .resize(16, 16, { fit: "contain", background: "#ffffff" })
        .grayscale()
        .raw()
        .toBuffer();
    const ink = Array.from(pixels, (value) => (255 - value) / 255);
    const features = new Array<number>(512);
    for (let index = 0; index < 256; index++) {
        const x = index % 16;
        const y = Math.floor(index / 16);
        const left = ink[y * 16 + Math.max(0, x - 1)]!;
        const right = ink[y * 16 + Math.min(15, x + 1)]!;
        const up = ink[Math.max(0, y - 1) * 16 + x]!;
        const down = ink[Math.min(15, y + 1) * 16 + x]!;
        features[index] = ink[index]!;
        features[256 + index] = (right - left + down - up) / 2;
    }
    if (dims === features.length) {
        return l2Normalize(features);
    }
    return l2Normalize(Array.from({ length: dims }, (_, index) => features[index % features.length]!));
}

function lexicalScore(a: CatalogIcon, b: CatalogIcon): number {
    const left = iconGrams(a);
    const right = iconGrams(b);
    let intersection = 0;
    for (const value of left) {
        if (right.has(value)) {
            intersection += 1;
        }
    }
    return intersection / Math.max(1, left.size + right.size - intersection);
}

const gramCache = new Map<string, Set<string>>();

function iconGrams(icon: CatalogIcon): Set<string> {
    const cached = gramCache.get(icon.id);
    if (cached) {
        return cached;
    }
    const normalized = `  ${icon.labels
        .slice(0, 3)
        .join(" ")
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, " ")}  `;
    const result = new Set<string>();
    for (let index = 0; index < normalized.length - 2; index++) {
        result.add(normalized.slice(index, index + 3));
    }
    gramCache.set(icon.id, result);
    return result;
}

function buildGramIndex(icons: CatalogIcon[]): Map<string, CatalogIcon[]> {
    const index = new Map<string, CatalogIcon[]>();
    for (const icon of icons) {
        for (const gram of iconGrams(icon)) {
            const matches = index.get(gram) ?? [];
            matches.push(icon);
            index.set(gram, matches);
        }
    }
    return index;
}

function lexicalCandidates(
    anchor: CatalogIcon,
    index: Map<string, CatalogIcon[]>,
    count = 48
): CatalogIcon[] {
    const overlap = new Map<CatalogIcon, number>();
    for (const gram of iconGrams(anchor)) {
        for (const icon of index.get(gram) ?? []) {
            overlap.set(icon, (overlap.get(icon) ?? 0) + 1);
        }
    }
    return [...overlap]
        .map(([icon, intersection]) => ({
            icon,
            score: intersection / Math.max(1, iconGrams(anchor).size + iconGrams(icon).size - intersection),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, count)
        .map((item) => item.icon);
}

function coarseSimilarity(a: number[], b: number[]): number {
    let score = 0;
    // Evenly sample 32 dimensions for a cheap shortlist.
    for (let i = 0; i < a.length; i += 16) {
        score += a[i]! * b[i]!;
    }
    return score;
}

function topCandidates(
    anchor: CatalogIcon,
    candidates: CatalogIcon[],
    vectors: Map<string, number[]>,
    count = 48
): CatalogIcon[] {
    const anchorVector = vectors.get(anchor.id)!;
    const scored: Array<{ icon: CatalogIcon; score: number }> = [];
    for (const icon of candidates) {
        const vector = vectors.get(icon.id);
        if (!vector) {
            continue;
        }
        const score = coarseSimilarity(anchorVector, vector);
        if (scored.length < count) {
            scored.push({ icon, score });
            if (scored.length === count) {
                scored.sort((a, b) => a.score - b.score);
            }
        } else if (score > scored[0]!.score) {
            scored[0] = { icon, score };
            scored.sort((a, b) => a.score - b.score);
        }
    }
    return scored.map((item) => item.icon);
}

function bestMatch(
    anchor: CatalogIcon,
    candidates: CatalogIcon[],
    vectors: Map<string, number[]>,
    textVectors: Map<string, number[]>,
    gramIndex: Map<string, CatalogIcon[]>
): { icon: CatalogIcon; score: number } {
    const anchorVector = vectors.get(anchor.id)!;
    const anchorTextVector = textVectors.get(anchor.id)!;
    const canonicalName = (icon: CatalogIcon) =>
        icon.name
            .split("/")
            .at(-1)!
            .replace(/-(?:outline|rounded|sharp)(?:-.+)?$/, "")
            .replaceAll("_", "-");
    const exact = candidates.filter((candidate) => canonicalName(candidate) === canonicalName(anchor));
    if (exact.length > 0) {
        const icon = exact.sort(
            (left, right) =>
                cosineSimilarity(anchorVector, vectors.get(right.id)!) -
                cosineSimilarity(anchorVector, vectors.get(left.id)!)
        )[0]!;
        return {
            icon,
            score:
                cosineSimilarity(anchorTextVector, textVectors.get(icon.id)!) * 0.55 +
                cosineSimilarity(anchorVector, vectors.get(icon.id)!) * 0.25 +
                lexicalScore(anchor, icon) * 0.2,
        };
    }
    let best = { icon: candidates[0]!, score: -Infinity };
    const shortlist = new Map(
        [...topCandidates(anchor, candidates, textVectors), ...lexicalCandidates(anchor, gramIndex)].map(
            (icon) => [icon.id, icon]
        )
    );
    for (const icon of shortlist.values()) {
        const semantic = cosineSimilarity(anchorTextVector, textVectors.get(icon.id)!);
        const visual = cosineSimilarity(anchorVector, vectors.get(icon.id)!);
        const lexical = lexicalScore(anchor, icon);
        const score = semantic * 0.42 + visual * 0.23 + lexical * 0.35;
        if (score > best.score) {
            best = { icon, score };
        }
    }
    return best;
}

function quantize(vectors: number[][]): Int8Array {
    const dims = vectors[0]?.length ?? 0;
    const output = new Int8Array(vectors.length * dims);
    vectors.forEach((vector, row) => {
        const maxAbs = Math.max(...vector.map(Math.abs), 1e-8);
        const scale = 127 / maxAbs;
        for (let col = 0; col < dims; col++) {
            output[row * dims + col] = Math.round(vector[col]! * scale);
        }
    });
    return output;
}

async function main(): Promise<void> {
    await mkdir(generatedDataDir, { recursive: true });
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const catalog = JSON.parse(
        await readFile(path.join(generatedDataDir, "catalog.json"), "utf8")
    ) as CatalogFile;
    const archiveFiles = new Map<string, ReturnType<typeof unzipSync>>();
    for (const provider of PROVIDERS) {
        const archive = catalog.archives[provider];
        if (archive?.path) {
            const archivePath =
                provider === "sfsymbols"
                    ? path.join(generatedDataDir, archive.path)
                    : path.join(archivesDir, `${provider}.zip`);
            archiveFiles.set(provider, unzipSync(new Uint8Array(await readFile(archivePath))));
        }
    }

    console.log(`Loading CLIP model ${MODEL}…`);
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL);

    const vectors = new Map<string, number[]>();
    const textVectors = new Map<string, number[]>();
    const modalities = new Map<string, "multimodal" | "text" | "image">();

    console.log(`Embedding names for ${catalog.icons.length} icons…`);
    for (let start = 0; start < catalog.icons.length; start += TEXT_BATCH) {
        const batch = catalog.icons.slice(start, start + TEXT_BATCH);
        const labels = batch.map((icon) => `an icon named ${icon.labels.slice(0, 4).join(", ")}`);
        const inputs = tokenizer(labels, { padding: "max_length", truncation: true });
        const { text_embeds } = await textModel(inputs);
        const rows = tensorRows(text_embeds, batch.length);
        batch.forEach((icon, index) => {
            textVectors.set(icon.id, rows[index]!);
            vectors.set(
                icon.id,
                l2Normalize([
                    ...rows[index]!.map((value) => value * TEXT_WEIGHT),
                    ...new Array<number>(VISUAL_DIMS).fill(0),
                ])
            );
            modalities.set(icon.id, "text");
        });
        if (start % (TEXT_BATCH * 25) === 0) {
            console.log(
                `  text ${Math.min(start + batch.length, catalog.icons.length)}/${catalog.icons.length}`
            );
        }
    }

    const iconsWithAssets = catalog.icons.filter((icon) => icon.asset);
    const textDims = (vectors.values().next().value?.length ?? 768) - VISUAL_DIMS;
    console.log(`Computing visual descriptors for ${iconsWithAssets.length} icons…`);
    let imageCount = 0;
    for (let start = 0; start < iconsWithAssets.length; start += IMAGE_BATCH) {
        const batch = iconsWithAssets.slice(start, start + IMAGE_BATCH);
        const prepared = await Promise.all(
            batch.map(async (icon) => {
                try {
                    if (icon.asset) {
                        const bytes = archiveFiles.get(icon.provider)?.[icon.asset.path];
                        if (!bytes) {
                            throw new Error(`Missing ${icon.asset.path} in ${icon.asset.archive}`);
                        }
                        return {
                            icon,
                            descriptor: await visualDescriptor(bytes, icon.asset.format, VISUAL_DIMS),
                        };
                    }
                } catch (error) {
                    console.warn(`  image skipped for ${icon.id}: ${String(error)}`);
                }
                return undefined;
            })
        );
        for (const item of prepared) {
            if (!item) {
                continue;
            }
            vectors.set(
                item.icon.id,
                l2Normalize([
                    ...vectors
                        .get(item.icon.id)!
                        .slice(0, textDims)
                        .map((value) => value * TEXT_WEIGHT),
                    ...item.descriptor.map((value) => value * VISUAL_WEIGHT),
                ])
            );
            modalities.set(item.icon.id, "multimodal");
            imageCount += 1;
        }
        if (start % (IMAGE_BATCH * 25) === 0) {
            console.log(
                `  image ${Math.min(start + batch.length, iconsWithAssets.length)}/${iconsWithAssets.length}`
            );
        }
    }

    const orderedVectors = catalog.icons.map((icon) => vectors.get(icon.id)!);
    const binary = quantize(orderedVectors);
    const embeddingIndex: EmbeddingIndexFile = {
        generatedAt: new Date().toISOString(),
        model: EMBEDDING_DESCRIPTION,
        dims: orderedVectors[0]!.length,
        quantization: "per-vector-symmetric-int8",
        dataPath: "/generated-data/embeddings.i8",
        ids: catalog.icons.map((icon) => icon.id),
        modalities: catalog.icons.map((icon) => modalities.get(icon.id)!),
    };
    await writeFile(path.join(generatedDataDir, "embeddings.i8"), binary);
    await writeFile(path.join(generatedDataDir, "embeddings-index.json"), JSON.stringify(embeddingIndex));
    await rm(path.join(generatedDataDir, "embeddings.json"), { force: true });

    console.log("Auditing existing package mappings…");
    const mappedByConcept = new Map<string, CatalogIcon[]>();
    for (const icon of catalog.icons) {
        for (const concept of icon.concepts ?? (icon.concept ? [icon.concept] : [])) {
            const items = mappedByConcept.get(concept) ?? [];
            items.push(icon);
            mappedByConcept.set(concept, items);
        }
    }
    const pairs: MappingPairScore[] = [];
    const conceptScores: MappingAuditFile["conceptScores"] = [];
    for (const [concept, icons] of mappedByConcept) {
        const conceptPairs: MappingPairScore[] = [];
        for (let i = 0; i < icons.length; i++) {
            for (let j = i + 1; j < icons.length; j++) {
                const left = icons[i]!;
                const right = icons[j]!;
                const score = cosineSimilarity(vectors.get(left.id)!, vectors.get(right.id)!);
                const pair = {
                    concept,
                    left: { provider: left.provider, name: left.name, id: left.id },
                    right: { provider: right.provider, name: right.name, id: right.id },
                    score,
                };
                pairs.push(pair);
                conceptPairs.push(pair);
            }
        }
        const scores = conceptPairs.map((pair) => pair.score);
        conceptScores.push({
            concept,
            meanScore: scores.reduce((sum, score) => sum + score, 0) / scores.length,
            minScore: Math.min(...scores),
            pairCount: scores.length,
        });
    }
    pairs.sort((a, b) => a.score - b.score);
    conceptScores.sort((a, b) => a.minScore - b.minScore);
    const audit: MappingAuditFile = { generatedAt: new Date().toISOString(), pairs, conceptScores };
    await writeFile(path.join(generatedDataDir, "mapping-audit.json"), JSON.stringify(audit));

    console.log("Generating Blueprint-anchored universal mapping draft…");
    const iconsByProvider = new Map(
        PROVIDERS.map((provider) => [provider, catalog.icons.filter((icon) => icon.provider === provider)])
    );
    const gramIndexes = new Map(
        PROVIDERS.map((provider) => [provider, buildGramIndex(iconsByProvider.get(provider)!)])
    );
    const blueprintIcons = iconsByProvider.get("blueprint")!;
    const draftMappings: DraftMapping[] = [];

    for (let index = 0; index < blueprintIcons.length; index++) {
        const anchor = blueprintIcons[index]!;
        const concept = anchor.concept ?? anchor.name;
        const status = anchor.concept ? "existing" : "generated";
        const providers: DraftMapping["providers"] = {
            blueprint: { id: anchor.id, name: anchor.name, score: 1 },
        };

        for (const provider of PROVIDERS.filter((item) => item !== "blueprint")) {
            const candidates = iconsByProvider.get(provider)!;
            const forced = anchor.concept
                ? candidates.find((icon) =>
                      (icon.concepts ?? (icon.concept ? [icon.concept] : [])).includes(anchor.concept!)
                  )
                : undefined;
            const match = forced
                ? {
                      icon: forced,
                      score: cosineSimilarity(vectors.get(anchor.id)!, vectors.get(forced.id)!),
                  }
                : bestMatch(anchor, candidates, vectors, textVectors, gramIndexes.get(provider)!);
            providers[provider] = {
                id: match.icon.id,
                name: match.icon.name,
                score: match.score,
            };
        }

        const scores = Object.values(providers)
            .filter((value) => value && value.id !== anchor.id)
            .map((value) => value!.score);
        draftMappings.push({
            concept,
            blueprintId: anchor.id,
            status,
            providers,
            meanScore: scores.reduce((sum, score) => sum + score, 0) / scores.length,
            minScore: Math.min(...scores),
        });
        if ((index + 1) % 50 === 0) {
            console.log(`  draft ${index + 1}/${blueprintIcons.length}`);
        }
    }
    draftMappings.sort((a, b) => a.minScore - b.minScore);
    const draft: DraftMappingsFile = {
        generatedAt: new Date().toISOString(),
        anchorProvider: "blueprint",
        mappings: draftMappings,
    };
    await writeFile(path.join(generatedDataDir, "draft-mappings.json"), JSON.stringify(draft));

    console.log(
        `Wrote ${catalog.icons.length} vectors (${(binary.length / 1024 / 1024).toFixed(1)} MiB, ${imageCount} multimodal).`
    );
    console.log(`Drafted ${draftMappings.length}/${blueprintIcons.length} Blueprint mappings.`);
    console.log("Weakest existing concepts:");
    for (const row of conceptScores.slice(0, 10)) {
        console.log(
            `  ${row.concept.padEnd(18)} min=${row.minScore.toFixed(3)} mean=${row.meanScore.toFixed(3)}`
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
