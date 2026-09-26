/** Cosine similarity for L2-normalized vectors equals dot product. */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i]! * b[i]!;
    }
    return sum;
}

export function l2Normalize(vector: number[]): number[] {
    let sumSquares = 0;
    for (const value of vector) {
        sumSquares += value * value;
    }
    const norm = Math.sqrt(sumSquares);
    if (norm === 0) {
        return vector.map(() => 0);
    }
    return vector.map((value) => value / norm);
}

export function averageVectors(vectors: number[][]): number[] {
    if (vectors.length === 0) {
        return [];
    }
    const dims = vectors[0]!.length;
    const out = new Array<number>(dims).fill(0);
    for (const vector of vectors) {
        for (let i = 0; i < dims; i++) {
            out[i]! += vector[i]!;
        }
    }
    for (let i = 0; i < dims; i++) {
        out[i]! /= vectors.length;
    }
    return l2Normalize(out);
}

/** Project high-dimensional points to 2D with a cheap PCA. */
export function projectTo2d(vectors: number[][]): Array<{ x: number; y: number }> {
    if (vectors.length === 0) {
        return [];
    }
    const dims = vectors[0]!.length;
    const mean = new Array<number>(dims).fill(0);
    for (const vector of vectors) {
        for (let i = 0; i < dims; i++) {
            mean[i]! += vector[i]!;
        }
    }
    for (let i = 0; i < dims; i++) {
        mean[i]! /= vectors.length;
    }

    const centered = vectors.map((vector) => vector.map((value, i) => value - mean[i]!));

    const axisA = powerIteration(centered, dims, 24);
    const axisB = powerIteration(deflate(centered, axisA), dims, 24);

    return centered.map((vector) => ({
        x: dot(vector, axisA),
        y: dot(vector, axisB),
    }));
}

function dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i]! * b[i]!;
    }
    return sum;
}

function powerIteration(rows: number[][], dims: number, iterations: number): number[] {
    let axis = l2Normalize(Array.from({ length: dims }, (_, i) => ((i * 17) % 97) / 97));
    for (let iter = 0; iter < iterations; iter++) {
        const next = new Array<number>(dims).fill(0);
        for (const row of rows) {
            const weight = dot(row, axis);
            for (let i = 0; i < dims; i++) {
                next[i]! += row[i]! * weight;
            }
        }
        axis = l2Normalize(next);
    }
    return axis;
}

function deflate(rows: number[][], axis: number[]): number[][] {
    return rows.map((row) => {
        const projection = dot(row, axis);
        return row.map((value, i) => value - projection * axis[i]!);
    });
}
