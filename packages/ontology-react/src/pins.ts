"use client";
import { useCallback, useEffect, useState } from "react";
import { useOntology } from "./context.js";
import type { PinStatus, PinOptions, QueryDocument } from "@party-stack/ontology";

/** Observe the owning replica's persisted offline graph; a tab targets its parent. */
export function useOfflinePin() {
    const { pins } = useOntology();
    const [state, setState] = useState<{ pins: typeof pins; status?: PinStatus; error?: unknown }>();
    useEffect(() => {
        let active = true;
        const stop = pins.subscribe(
            (status) => {
                if (active) setState({ pins, status });
            },
            (error) => {
                if (active) setState({ pins, error });
            }
        );
        return () => {
            active = false;
            stop();
        };
    }, [pins]);
    const set = useCallback((query: QueryDocument, options?: PinOptions) => pins.set(query, options), [pins]);
    const clear = useCallback(() => pins.clear(), [pins]);
    return {
        status: state?.pins === pins ? state.status : undefined,
        error: state?.pins === pins ? state.error : undefined,
        isLoading: state?.pins !== pins,
        set,
        clear,
    };
}
