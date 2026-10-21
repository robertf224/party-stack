import { createEffectLocalCollection } from "../collections/localCollection.js";
import type { RuntimeAdapter } from "../types.js";
import type { Collection } from "@tanstack/db";
import type { Scope } from "effect";

export function createLocalCollection<T extends object, TKey extends string | number>(options: {
    name: string;
    getKey: (value: T) => TKey;
    runtime: RuntimeAdapter;
    schemaVersion?: number;
    /** Optional owner for the collection's Effect resources. */
    scope?: Scope.Scope;
}): Collection<T, TKey> {
    return createEffectLocalCollection(options);
}
