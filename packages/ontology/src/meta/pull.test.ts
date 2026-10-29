import { o } from "@party-stack/ontology-spec";
import { context, eq, field, selectField, sub } from "@party-stack/ontology-spec/query";
import { asRuntimeLayer, memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { expect, test } from "vite-plus/test";
import { createLocalMetaOntologyBackendAdapter } from "./createLocalMetaOntologyBackendAdapter.js";
import { createMetaLiveOntology } from "./generated/live.js";
import { pull } from "./pull.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

test("metadata pull preserves the descriptor contract and transitive context/value definitions", async () => {
    const ir: OntologyIR = {
        displayName: "Example",
        description: "Contract metadata",
        types: [
            { name: "Alias", type: o.ref({ name: "Identity" }) },
            { name: "Identity", type: o.string({}) },
            {
                name: "Context",
                type: o.struct({
                    fields: [{ name: "user", displayName: "User", type: o.ref({ name: "Alias" }) }],
                }),
            },
        ],
        context: { type: o.ref({ name: "Context" }), partition: [["user"]] },
        objectTypes: [
            {
                name: "Item",
                displayName: "Item",
                pluralDisplayName: "Items",
                primaryKey: "id",
                properties: [{ name: "id", displayName: "ID", type: o.ref({ name: "Alias" }) }],
            },
        ],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
        policy: {
            read: {
                select: [
                    sub("items", {
                        from: { source: { objectType: "Item" }, binding: "i" },
                        where: eq(field("i", "id"), context("user")),
                        select: [selectField("id", field("i", "id"))],
                    }),
                ],
            },
        },
    };
    const live = await createMetaLiveOntology({
        backend: () => createLocalMetaOntologyBackendAdapter(ir),
        runtime: asRuntimeLayer(memoryRuntimeFixture),
    });
    try {
        const result = await pull(live, {
            objectTypeNames: ["Item"],
            actionTypeNames: [],
            queryFunctionTypeNames: [],
        });
        expect(result.displayName).toBe(ir.displayName);
        expect(result.description).toBe(ir.description);
        expect(result.context).toEqual(ir.context);
        expect(result.policy).toEqual(ir.policy);
        expect(new Set(result.types.map((t) => t.name))).toEqual(new Set(["Alias", "Identity", "Context"]));
        await expect(
            pull(live, { objectTypeNames: [], actionTypeNames: [], queryFunctionTypeNames: [] })
        ).rejects.toThrow(/incomplete|invalid/);
    } finally {
        await live.cleanup();
    }
});
