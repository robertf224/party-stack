import { createContext, use, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { createFoundryOntologyBackend } from "@party-stack/foundry-ontology";
import { createFoundryMetaOntologyBackendAdapter } from "@party-stack/foundry-ontology/meta";
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
    const meta = use(
        useMemo(() => {
            const client = getClient();
            const metaBackendAdapter = createFoundryMetaOntologyBackendAdapter({
                client,
            });
            return createMetaLiveOntology({
                backend: () => metaBackendAdapter,
            });
        }, [])
    );

    useEffect(
        () => () => {
            void meta.cleanup();
        },
        [meta]
    );

    return <OntologyInner meta={meta}>{children}</OntologyInner>;
}

function OntologyInner({ meta, children }: { meta: LiveOntology<MetaOntology>; children: ReactNode }) {
    const { data: objectTypes } = useLiveQuery(
        (q) => q.from({ ot: meta.objects.ObjectType }).select(({ ot }) => ({ ...ot })),
        []
    );

    const { data: linkTypes } = useLiveQuery(
        (q) => q.from({ lt: meta.objects.LinkType }).select(({ lt }) => ({ ...lt })),
        []
    );

    const { data: valueTypes } = useLiveQuery(
        (q) => q.from({ vt: meta.objects.ValueType }).select(({ vt }) => ({ ...vt })),
        []
    );

    const [data, setData] = useState<LiveOntology | null>(null);
    const [error, setError] = useState<Error>();

    useEffect(() => {
        if (objectTypes.length === 0) {
            setData(null);
            return;
        }
        const ir = {
            types: valueTypes,
            objectTypes: objectTypes,
            linkTypes: linkTypes,
            actionTypes: [],
        } as unknown as OntologyIR;

        const client = getClient();
        const backend = createFoundryOntologyBackend({
            client,
        });
        let active = true;
        let ontology: LiveOntology | undefined;
        void createLiveOntology({
            ir,
            backend,
        }).then(
            (created) => {
                if (!active) {
                    void created.cleanup();
                    return;
                }
                ontology = created;
                setError(undefined);
                setData(created);
            },
            (reason: unknown) => {
                if (!active) return;
                setError(reason instanceof Error ? reason : new Error(String(reason)));
            }
        );
        return () => {
            active = false;
            void ontology?.cleanup();
        };
    }, [linkTypes, objectTypes, valueTypes]);

    if (error) throw error;

    return <OntologyContext.Provider value={{ meta, data }}>{children}</OntologyContext.Provider>;
}
