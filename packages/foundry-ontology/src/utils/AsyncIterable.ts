import { BackendError } from "@party-stack/ontology-backend";

// TODO: move to utils

// Replace later with https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/fromAsync
export async function toArray<T>(asyncIterable: AsyncIterable<T>): Promise<T[]> {
    const result = [];
    for await (const element of asyncIterable) {
        result.push(element);
    }
    return result;
}

export async function* fromBatches<T, R>(
    values: readonly T[],
    getBatch: (batch: T[]) => Promise<readonly R[]>,
    batchSize: number
): AsyncIterable<R> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new RangeError("Batch size must be a positive integer.");
    }
    for (let index = 0; index < values.length; index += batchSize) {
        const results = await getBatch(values.slice(index, index + batchSize));
        for (const result of results) {
            yield result;
        }
    }
}

export async function* fromPagination<C extends string | number, P, T>(
    getPage: (pageSize: number, pageToken?: C) => Promise<P>,
    getPageToken: (page: P) => C | undefined,
    getElements: (page: P) => readonly T[] | Promise<readonly T[]>,
    defaultPageSize: number,
    limit: number = Infinity
): AsyncIterable<T> {
    const visited = new Set<C>();
    let pageToken: C | undefined = undefined;
    let hasMore = true;
    let count = 0;
    while (hasMore && count < limit) {
        if (pageToken !== undefined) {
            if (visited.has(pageToken))
                throw new BackendError({
                    operation: "provider.pagination",
                    kind: "InvalidResponse",
                    message: "The provider repeated a pagination cursor.",
                    retryable: false,
                });
            visited.add(pageToken);
        }
        const page = await getPage(Math.min(limit - count, defaultPageSize), pageToken);
        const elements = await getElements(page);
        for (const element of elements) {
            yield element;
        }
        count += elements.length;
        pageToken = getPageToken(page);
        if (pageToken === undefined) {
            hasMore = false;
        }
    }
}
