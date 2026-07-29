"use client";

import { useCallback } from "react";
import type { LiveOntologyAction } from "@party-stack/ontology";

export function useAction<TParameters extends Record<string, unknown>>(
    action: LiveOntologyAction<TParameters>
) {
    return useCallback(
        (parameters: TParameters) => action(parameters),
        [action]
    );
}
