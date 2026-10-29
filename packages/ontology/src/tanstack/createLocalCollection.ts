import { createEffectLocalCollection } from "./localCollection.js";
import type { RuntimeService } from "@party-stack/runtime";
import type { Collection } from "@tanstack/db";
import type { Scope } from "effect";

export function createLocalCollection<T extends object, TKey extends string | number>(options: {
    name: string;
    getKey: (value: T) => TKey;
    runtime: RuntimeService;
    schemaVersion?: number;
    /** Optional owner for the collection's Effect resources. */
    scope: Scope.Scope;
}): Collection<T, TKey> {
    return createEffectLocalCollection(options);
}
