export type IconProvider =
    | "blueprint"
    | "lucide"
    | "material"
    | "salesforce"
    | "sfsymbols";

export interface CatalogIcon {
    id: string;
    provider: IconProvider;
    name: string;
    /** Universal concept this icon is mapped to, if any. */
    concept?: string;
    /** All existing concepts using this asset (providers may intentionally reuse glyphs). */
    concepts?: string[];
    /** Asset stored inside a compact provider archive. */
    asset?: {
        archive: string;
        path: string;
        format: "svg" | "png";
    };
    /** True when we only have a name (no redistributable glyph). */
    textOnly?: boolean;
    /** Synonyms / alternate labels used for text embedding. */
    labels: string[];
}

export interface CatalogFile {
    providers: IconProvider[];
    concepts: string[];
    icons: CatalogIcon[];
    archives: Partial<
        Record<
            IconProvider,
            {
                path: string;
                iconCount: number;
                bytes: number;
                source: string;
                version: string;
                license: string;
            }
        >
    >;
}

/** Metadata for vectors stored as contiguous signed int8 values. */
export interface EmbeddingIndexFile {
    generatedAt: string;
    model: string;
    dims: number;
    quantization: "per-vector-symmetric-int8";
    dataPath: string;
    ids: string[];
    modalities: Array<"multimodal" | "text" | "image">;
}

export interface MappingPairScore {
    concept: string;
    left: { provider: IconProvider; name: string; id: string };
    right: { provider: IconProvider; name: string; id: string };
    score: number;
}

export interface MappingAuditFile {
    generatedAt: string;
    pairs: MappingPairScore[];
    conceptScores: Array<{
        concept: string;
        meanScore: number;
        minScore: number;
        pairCount: number;
    }>;
}

export interface DraftMapping {
    concept: string;
    blueprintId: string;
    status: "existing" | "generated";
    providers: Partial<
        Record<
            IconProvider,
            {
                id: string;
                name: string;
                score: number;
            }
        >
    >;
    meanScore: number;
    minScore: number;
}

export interface DraftMappingsFile {
    generatedAt: string;
    anchorProvider: "blueprint";
    mappings: DraftMapping[];
}
