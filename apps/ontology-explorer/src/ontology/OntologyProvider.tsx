import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { createFoundryOntologyAdapter } from "@party-stack/foundry-ontology";
import { createFoundryMetaOntologyAdapter } from "@party-stack/foundry-ontology/meta";
import {
    createMetaLiveOntology,
    createLiveOntology,
    type LiveOntology,
    type MetaOntology,
    type OntologyIR,
} from "@party-stack/ontology";
import { getClient } from "./client";

interface OntologyContextValue {
    meta: LiveOntology<MetaOntology>;
    data: LiveOntology | null;
}

const OntologyContext = createContext<OntologyContextValue>(null!);

export function useOntology() {
    return useContext(OntologyContext);
}

export function OntologyProvider({ children }: { children: ReactNode }) {
    const meta = useMemo(() => {
        const client = getClient();
        const metaAdapter = createFoundryMetaOntologyAdapter({ client });
        return createMetaLiveOntology(metaAdapter);
    }, []);

    return <OntologyInner meta={meta}>{children}</OntologyInner>;
}

function OntologyInner({ meta, children }: { meta: LiveOntology<MetaOntology>; children: ReactNode }) {
    const { data: objectTypes } = useLiveQuery(
        (q) =>
            q.from({ ot: meta.objects.ObjectType }).select(({ ot }) => ({ ...ot })),
        [],
    );

    const { data: linkTypes } = useLiveQuery(
        (q) =>
            q.from({ lt: meta.objects.LinkType }).select(({ lt }) => ({ ...lt })),
        [],
    );

    const { data: valueTypes } = useLiveQuery(
        (q) =>
            q.from({ vt: meta.objects.ValueType }).select(({ vt }) => ({ ...vt })),
        [],
    );

    const dataRef = useRef<LiveOntology | null>(null);

    if (!dataRef.current && objectTypes.length > 0) {
        const ir = {
            types: valueTypes,
            objectTypes: objectTypes,
            linkTypes: linkTypes,
            actionTypes: [],
        } as unknown as OntologyIR;

        const client = getClient();
        const adapter = createFoundryOntologyAdapter({ client, ir });
        dataRef.current = createLiveOntology({ ir, adapter });
    }

    return (
        <OntologyContext.Provider value={{ meta, data: dataRef.current }}>
            {children}
        </OntologyContext.Provider>
    );
}
