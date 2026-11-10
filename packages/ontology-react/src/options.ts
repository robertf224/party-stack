import { useMemo } from "react";
import type { CreateLiveOntologyOpts } from "@party-stack/ontology";

export type OntologyViewOptions = Omit<CreateLiveOntologyOpts, "ir" | "backend" | "client" | "ontology">;

/** Primitive JSX props can change independently without reopening the view on
 * every parent render. Object-valued construction inputs retain normal identity semantics.
 */
export function useViewOptions({
    id,
    live,
    runtime,
    writes,
    demand,
    cache,
    traceRecording,
    context,
    authentication,
    label,
    parent,
}: OntologyViewOptions) {
    return useMemo(() => {
        const values = {
            id,
            live,
            runtime,
            writes,
            demand,
            cache,
            traceRecording,
            context,
            authentication,
            label,
            parent,
        } satisfies Record<keyof OntologyViewOptions, unknown>;
        return Object.fromEntries(
            Object.entries(values).filter(([, value]) => value !== undefined)
        ) as OntologyViewOptions;
    }, [id, live, runtime, writes, demand, cache, traceRecording, context, authentication, label, parent]);
}
