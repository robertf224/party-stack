/**
 * Copy a definition so later edits to the caller's copy cannot change it. Plain objects, arrays,
 * maps and sets are copied; any other value a definition carries (a literal `Temporal.PlainDate`
 * default, for example) is immutable and kept as is. `structuredClone` would turn such a value
 * into an empty object, so the copy would no longer hash like the definition it came from.
 */
export function cloneDefinition<A>(value: A): A {
    const clone = (value: unknown): unknown => {
        if (value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(clone);
        if (value instanceof Map) return new Map([...value].map(([key, item]) => [clone(key), clone(item)]));
        if (value instanceof Set) return new Set([...value].map(clone));
        if (value instanceof Date) return new Date(value.getTime());
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return value;
        const copy: Record<string, unknown> = Object.create(prototype as object | null);
        for (const [key, item] of Object.entries(value))
            Object.defineProperty(copy, key, {
                value: clone(item),
                enumerable: true,
                writable: true,
                configurable: true,
            });
        return copy;
    };
    return clone(value) as A;
}
