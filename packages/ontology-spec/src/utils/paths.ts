function isStruct(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getAtPath(value: unknown, path: readonly string[]): unknown {
    let current = value;
    for (const segment of path) {
        if (!isStruct(current)) return undefined;
        current = current[segment];
    }
    return current;
}

export function setAtPath<T>(value: T, path: readonly string[], replacement: unknown): T {
    if (path.length === 0) {
        throw new Error("Property paths must not be empty.");
    }
    return setAtPathInternal(value, path, replacement, path, []) as T;
}

function setAtPathInternal(
    value: unknown,
    path: readonly string[],
    replacement: unknown,
    fullPath: readonly string[],
    traversedPath: readonly string[]
): unknown {
    if (path.length === 0) return replacement;
    if (value !== undefined && !isStruct(value)) {
        throw new Error(
            `Cannot assign property path "${fullPath.join(".")}": "${traversedPath.join(".")}" is not a struct object.`
        );
    }

    const [segment, ...rest] = path;
    const struct = value ?? {};
    return {
        ...struct,
        [segment!]: setAtPathInternal(struct[segment!], rest, replacement, fullPath, [
            ...traversedPath,
            segment!,
        ]),
    };
}

export function unsetAtPath<T>(value: T, path: readonly string[]): T {
    if (path.length === 0) {
        throw new Error("Property paths must not be empty.");
    }
    return unsetAtPathInternal(value, path) as T;
}

function unsetAtPathInternal(value: unknown, path: readonly string[]): unknown {
    if (!isStruct(value)) return value;

    const [segment, ...rest] = path;
    const result = { ...value };
    if (rest.length === 0) {
        delete result[segment!];
    } else if (segment! in result) {
        result[segment!] = unsetAtPathInternal(result[segment!], rest);
    }
    return result;
}
