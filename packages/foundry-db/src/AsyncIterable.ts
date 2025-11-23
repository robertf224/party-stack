// TODO: move to utils

// Replace later with https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/fromAsync
export async function toArray<T>(asyncIterable: AsyncIterable<T>): Promise<T[]> {
    const result = [];
    for await (const element of asyncIterable) {
        result.push(element);
    }
    return result;
}

export async function* fromPagination<C extends string | number, P, T>(
    getPage: (cursor?: C) => Promise<P>,
    getCursor: (page: P) => C | undefined,
    getElements: (page: P) => T[] | Promise<T[]>
): AsyncIterable<T> {
    let cursor: C | undefined = undefined;
    let hasMore = true;
    while (hasMore) {
        const page: P = await getPage(cursor);
        const elements = await getElements(page);
        for (const element of elements) {
            yield element;
        }
        cursor = getCursor(page);
        if (cursor === undefined) {
            hasMore = false;
        }
    }
}
