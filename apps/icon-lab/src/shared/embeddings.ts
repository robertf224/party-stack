import type { EmbeddingIndexFile } from "./types";

export class QuantizedEmbeddingStore {
    readonly index: EmbeddingIndexFile;
    private readonly data: Int8Array;
    private readonly rowById: Map<string, number>;
    private readonly norms: Float32Array;

    constructor(index: EmbeddingIndexFile, data: Int8Array) {
        if (data.length !== index.ids.length * index.dims) {
            throw new Error(
                `Embedding data length ${data.length} does not match ${index.ids.length} × ${index.dims}`
            );
        }
        this.index = index;
        this.data = data;
        this.rowById = new Map(index.ids.map((id, row) => [id, row]));
        this.norms = new Float32Array(index.ids.length);
        for (let row = 0; row < index.ids.length; row++) {
            let sum = 0;
            const offset = row * index.dims;
            for (let col = 0; col < index.dims; col++) {
                const value = data[offset + col]!;
                sum += value * value;
            }
            this.norms[row] = Math.sqrt(sum);
        }
    }

    has(id: string): boolean {
        return this.rowById.has(id);
    }

    similarity(leftId: string, rightId: string): number {
        const left = this.rowById.get(leftId);
        const right = this.rowById.get(rightId);
        if (left === undefined || right === undefined) {
            return 0;
        }
        let dot = 0;
        const leftOffset = left * this.index.dims;
        const rightOffset = right * this.index.dims;
        for (let col = 0; col < this.index.dims; col++) {
            dot += this.data[leftOffset + col]! * this.data[rightOffset + col]!;
        }
        return dot / (this.norms[left]! * this.norms[right]!);
    }

    vector(id: string): number[] {
        const row = this.rowById.get(id);
        if (row === undefined) {
            return [];
        }
        const offset = row * this.index.dims;
        const norm = this.norms[row]!;
        return Array.from(
            this.data.subarray(offset, offset + this.index.dims),
            (value) => value / norm
        );
    }
}

export async function loadEmbeddingStore(index: EmbeddingIndexFile): Promise<QuantizedEmbeddingStore> {
    const response = await fetch(index.dataPath);
    if (!response.ok) {
        throw new Error(`Failed to load embeddings: ${response.status}`);
    }
    return new QuantizedEmbeddingStore(index, new Int8Array(await response.arrayBuffer()));
}
