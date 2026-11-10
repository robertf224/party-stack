import { objectSubset } from "@party-stack/ontology-backend/subset";
import { Effect, Predicate, Stream } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

/** Policy predicates can depend on objects outside the requested type. Observe
 * whole dependency types: the caller's filter is not a filter on access changes.
 */
export function policyWatches(backend: OntologyBackendService, ir: OntologyIR) {
    const known = new Set(ir.objectTypes.map((type) => type.name));
    const dependencies = new Set<string>();
    function visit(value: unknown): void {
        if (!Predicate.isObject(value)) return;
        if ("kind" in value && value.kind === "literal") return;
        // A lookup's target is determined by expression typing. Conservatively
        // include every local type until dependency analysis tracks those types.
        if ("kind" in value && value.kind === "lookup") for (const type of known) dependencies.add(type);
        if ("objectType" in value && Predicate.isString(value.objectType) && known.has(value.objectType))
            dependencies.add(value.objectType);
        if ("link" in value && Predicate.isString(value.link))
            for (const link of ir.linkTypes)
                if (link.source.name === value.link || link.target.name === value.link) {
                    dependencies.add(link.source.objectType);
                    dependencies.add(link.target.objectType);
                }
        for (const child of Object.values(value)) {
            if (Array.isArray(child)) child.forEach(visit);
            else visit(child);
        }
    }
    visit(ir.policy?.objects);
    const subsets = (requested: ObjectSubset) =>
        [...new Set([requested.from.source.objectType, ...dependencies])].map((type) => objectSubset(type));
    return {
        watch: (requested: ObjectSubset) => {
            if (backend.changes?.watch) return backend.changes.watch;
            const watches = subsets(requested).map((subset) => backend.watchSubset?.(subset));
            // A partial watch would falsely claim to cover permission changes.
            if (watches.some((watch) => watch === undefined)) return undefined;
            return Effect.all(
                watches.filter((watch) => watch !== undefined),
                { concurrency: "unbounded" }
            ).pipe(Effect.map((streams) => Stream.mergeAll(streams, { concurrency: "unbounded" })));
        },
        refresh: (requested: ObjectSubset) => {
            const own = backend.refresh?.(requested);
            const intervals = subsets(requested).flatMap((subset) => {
                const interval = backend.refresh?.(subset)?.pollIntervalMs;
                return typeof interval === "number" ? [interval] : [];
            });
            return intervals.length ? { ...own, pollIntervalMs: Math.min(...intervals) } : own;
        },
    };
}
