"use client";

import { createTransaction, type TransactionConfig } from "@tanstack/db";
import { useCallback } from "react";
import type { LiveOntologyAction } from "@party-stack/ontology";

type UseActionOptions = Omit<TransactionConfig, "mutationFn">;

export function useAction<TParameters extends Record<string, unknown>>(
    action: LiveOntologyAction<TParameters>,
    options?: UseActionOptions
) {
    return useCallback(
        (parameters: TParameters) => {
            const execution = action(parameters);
            const transaction = createTransaction({
                ...options,
                mutationFn: execution.mutationFn,
            });

            transaction.mutate(execution.mutator);

            return transaction;
        },
        [action, options]
    );
}
