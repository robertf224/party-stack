import {
    createOntologyDevtoolsPlugin,
    ontologyDevtoolsTrigger,
    preloadOntologyDevtools,
} from "@party-stack/ontology-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useEffect, useMemo } from "react";
import type { TrackerOntology } from "./profiles";

const config = { customTrigger: ontologyDevtoolsTrigger, position: "bottom-right" as const };

export function TrackerDevtools({ ontology, ready }: { ontology: TrackerOntology; ready: boolean }) {
    const plugins = useMemo(() => [createOntologyDevtoolsPlugin({ ontology })], [ontology]);
    useEffect(() => {
        if (ready) void preloadOntologyDevtools().catch(() => undefined);
    }, [ready]);
    return <TanStackDevtools config={config} plugins={plugins} />;
}
