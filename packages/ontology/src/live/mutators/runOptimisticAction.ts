import { createMutatorTx } from "./createMutatorTx.js";
import { applyActionLogicToMutatorTx } from "./OntologyEdits.js";
import type { OntologyCollection } from "../objects/types.js";
import type { OntologyMutatorRegistry, PrepareTransactionSources } from "./types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { OntologyObject } from "@party-stack/ontology-spec";
import type { Transaction } from "@tanstack/db";

export async function runOptimisticAction(options: {
    transaction: Transaction;
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    context: Record<string, unknown>;
    idempotencyKey: string;
    replay?: import("../expression.js").ExpressionReplay;
    objects: Record<string, OntologyCollection<OntologyObject>>;
    mutators?: OntologyMutatorRegistry;
    ensureLoaded?: PrepareTransactionSources;
    onMutation?: Parameters<typeof createMutatorTx>[0]["onMutation"];
}): Promise<void> {
    const tx = createMutatorTx({
        transaction: options.transaction,
        objects: options.objects,
        ensureLoaded: options.ensureLoaded,
        onMutation: options.onMutation,
        primaryKeys: Object.fromEntries(
            options.ir.objectTypes.map((objectType) => [objectType.name, objectType.primaryKey])
        ),
    });
    await applyActionLogicToMutatorTx({
        ir: options.ir,
        actionTypeName: options.actionTypeName,
        parameters: options.parameters,
        context: options.context,
        idempotencyKey: options.idempotencyKey,
        replay: options.replay,
        objects: options.objects,
        tx,
    });

    const mutator = options.mutators?.[options.actionTypeName];
    if (!mutator) return;

    await mutator({
        tx,
        args: options.parameters,
        context: options.context,
    });
}
