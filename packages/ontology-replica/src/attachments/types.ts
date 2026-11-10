export interface PartialBlobMetadata {
    size?: number;
    type?: string;
    name?: string | null;
    dimensions?: BlobDimensions | null;
}

export interface BlobDimensions {
    width: number;
    height: number;
}

export interface BlobReadOptions {
    signal?: AbortSignal;
    meta?: Record<string, unknown>;
}

export type BlobMetadataField = keyof PartialBlobMetadata;

export interface BlobMetadataOptions extends BlobReadOptions {
    select?: readonly BlobMetadataField[];
}
