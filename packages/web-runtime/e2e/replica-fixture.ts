import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect } from "effect";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";

export const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};
export const increment = (tx: OwnedTransaction) =>
    Effect.gen(function* () {
        const row = yield* tx.get("Counter", "one");
        yield* tx.put("Counter", { id: "one", count: Number(row?.count ?? 0) + 1 });
    });
