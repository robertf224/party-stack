export async function provide<Args extends unknown[], T extends object>(
    provider: T | ((...args: Args) => T | Promise<T>),
    ...args: Args
): Promise<T> {
    if (typeof provider === "function") {
        const value = await provider(...args);
        return value;
    } else {
        const value = provider;
        return value;
    }
}
