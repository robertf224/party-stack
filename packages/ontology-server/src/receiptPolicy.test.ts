import { o } from "@party-stack/ontology-spec";
import { context, eq, field, literal, sub } from "@party-stack/ontology-spec/query";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { receiptPolicyProof } from "./receiptPolicy.js";
import type { OntologyIR, Query, QuerySelection } from "@party-stack/ontology-spec";

const query: Query = {
    from: { source: { objectType: "Item" }, binding: "item" },
    where: eq(field("item", "id"), context("id")),
    select: [],
};
const grant = sub("items", query);
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: ["id", "owner"].map((name) => ({ name, displayName: name, type: o.string({}) })),
        },
    ],
};

test.each<{ name: string; select: QuerySelection[]; allowed: boolean }>([
    { name: "matching ID", select: [grant], allowed: true },
    {
        name: "union with another grant",
        select: [sub("none", { ...query, where: literal(false) }), grant],
        allowed: true,
    },
    {
        name: "row-dependent condition",
        select: [sub("items", { ...query, where: eq(field("item", "owner"), literal(undefined)) })],
        allowed: false,
    },
    {
        name: "local row used as a value",
        select: [
            sub("items", {
                ...query,
                where: eq(o.Expression.localReference({ name: "item" }), literal({ id: "a" })),
            }),
        ],
        allowed: false,
    },
    { name: "window", select: [sub("items", { ...query, page: { limit: 1 } })], allowed: false },
    {
        name: "singular selection",
        select: [o.QuerySelection.sub({ name: "item", query, cardinality: "one" })],
        allowed: false,
    },
    {
        name: "ancestor-dependent grant",
        select: [
            sub("parents", { ...query, where: eq(field("item", "owner"), context("id")), select: [grant] }),
        ],
        allowed: false,
    },
    {
        name: "conditional grant without specialization",
        select: [o.QuerySelection.selectCase({ branches: [{ condition: literal(true), select: [grant] }] })],
        allowed: false,
    },
])("receipt proof conservatively handles $name", async ({ select, allowed }) => {
    const proof = receiptPolicyProof({ ...ir, policy: { objects: { select } } }, { id: "a" });
    expect(await Effect.runPromise(proof("Item", "a"))).toBe(allowed);
    expect(await Effect.runPromise(proof("Other", "a"))).toBe(false);
    expect(await Effect.runPromise(proof("Item", "b"))).toBe(false);
});
