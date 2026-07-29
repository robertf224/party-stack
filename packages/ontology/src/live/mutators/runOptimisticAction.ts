import { createMutatorTx } from "./createMutatorTx.js";
import { applyActionLogicToMutatorTx } from "./OntologyEdits.js";
import type { OntologyMutatorRegistry } from "./types.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyCollection } from "../objects/createLiveOntologyObjectCollection.js";
import type { OntologyObject } from "../objects/OntologyObject.js";
import type { Transaction } from "@tanstack/db";

export async function runOptimisticAction(options: {
    transaction: Transaction;
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    context: Record<string, unknown>;
    objects: Record<
        string,
        OntologyCollection<OntologyObject>
    >;
    mutators?: OntologyMutatorRegistry;
}): Promise<void> {
    const tx = createMutatorTx({
        transaction: options.transaction,
        objects: options.objects,
        primaryKeys: Object.fromEntries(
            options.ir.objectTypes.map(
                (objectType) => [
                    objectType.name,
                    objectType.primaryKey,
                ]
            )
        ),
    });
    await applyActionLogicToMutatorTx({
        ir: options.ir,
        actionTypeName: options.actionTypeName,
        parameters: options.parameters,
        context: options.context,
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
