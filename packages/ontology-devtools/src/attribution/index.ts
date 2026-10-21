import { useEffect, useId, useMemo } from "react";
import { registerQueryConsumer, type DemandOwner } from "./registry.js";

/** Injected by the development-only Vite plugin. IDs distinguish mounted instances. */
export function useDemandOwner(name: string, source: string): DemandOwner {
    const id = useId();
    return useMemo(() => ({ id, name, source }), [id, name, source]);
}
/** Preserve the hook's result and query identity; register only committed consumers. */
export function useDemandQuery<A extends { readonly collection?: object }>(owner: DemandOwner, result: A): A {
    const collection = result.collection;
    useEffect(() => (collection ? registerQueryConsumer(owner, collection) : undefined), [owner, collection]);
    return result;
}
