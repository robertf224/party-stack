import { useSyncExternalStore } from "react";
import type { PerformanceSpan } from "./traceWaterfall.js";
import type { LiveOntology } from "@party-stack/ontology";

export type Diagnostics = NonNullable<LiveOntology["diagnostics"]>;
export type Status = NonNullable<ReturnType<Diagnostics["replica"]["getSnapshot"]>["status"]>;
export type Demand = Status["demands"][number];
export type Load = Status["loads"][number];
const empty = {};
const noSnapshot = () => empty;
const emptySpans: readonly PerformanceSpan[] = [];
const noSpans = () => emptySpans;
const noSubscription = () => () => undefined;
export function useReplicaStatus(diagnostics?: Diagnostics) {
    const store = diagnostics?.replica;
    return useSyncExternalStore(
        store?.subscribe ?? noSubscription,
        store?.getSnapshot ?? noSnapshot,
        noSnapshot
    ) as ReturnType<Diagnostics["replica"]["getSnapshot"]>;
}
export function useTraceSpans(store?: LiveOntology["traces"]) {
    return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noSpans, noSpans);
}
export function diagnosticTargets(diagnostics?: Diagnostics) {
    const targets: { label: string; value: Diagnostics }[] = [];
    for (let node = diagnostics; node; node = node.parent) {
        if (targets.some((target) => target.value === node)) break;
        const label = !targets.length ? "This tab" : (node.location ?? node.label ?? "Host");
        targets.push({ label, value: node });
    }
    return targets;
}
export const ms = (value: number) =>
    value < 1 ? `${(value * 1000).toFixed(0)} µs` : `${value.toFixed(1)} ms`;
