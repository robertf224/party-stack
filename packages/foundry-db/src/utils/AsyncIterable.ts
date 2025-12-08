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
    getPage: (pageSize: number, pageToken?: C) => Promise<P>,
    getpageToken: (page: P) => C | undefined,
    getElements: (page: P) => T[] | Promise<T[]>,
    defaultPageSize: number,
    limit: number = Infinity
): AsyncIterable<T> {
    let pageToken: C | undefined = undefined;
    let hasMore = true;
    let count = 0;
    while (hasMore && count < limit) {
        const page = await getPage(Math.min(limit - count, defaultPageSize), pageToken);
        const elements = await getElements(page);
        for (const element of elements) {
            yield element;
        }
        count += elements.length;
        pageToken = getpageToken(page);
        if (pageToken === undefined) {
            hasMore = false;
        }
    }
}
