import { it } from "@effect/vitest";
import { Arbitrary, Effect, Order, Schema } from "effect";
import { expect, test } from "vitest";
import * as BTree from "./btree.js";

interface Entry {
    readonly key: number;
    readonly value: number;
}
const order = Order.mapInput(Order.Number, (entry: Entry) => entry.key);
const sorted = (entries: ReadonlyMap<number, Entry>) => [...entries.values()].sort((a, b) => a.key - b.key);
function shape<A>(
    tree: BTree.BTree<A>,
    order: Order.Order<A>,
    root = true
): { height: number; size: number; nodes: Set<object> } {
    if (!tree) return { height: 0, size: 0, nodes: new Set() };
    const nodes = new Set<object>([tree]);
    const count = tree.kind === "leaf" ? tree.items.length : tree.children.length;
    expect(count).toBeGreaterThanOrEqual(root ? 1 : 16);
    expect(count).toBeLessThanOrEqual(32);
    if (tree.kind === "leaf") {
        for (let i = 1; i < tree.items.length; i++)
            expect(order(tree.items[i - 1]!, tree.items[i]!)).toBe(-1);
        expect(tree.size).toBe(tree.items.length);
        expect(tree.maximum).toBe(tree.items.at(-1));
        return { height: 1, size: tree.size, nodes };
    }
    expect(tree.children.length).toBeGreaterThanOrEqual(root ? 2 : 16);
    const children = tree.children.map((child) => shape(child, order, false));
    expect(new Set(children.map((child) => child.height)).size).toBe(1);
    expect(tree.size).toBe(children.reduce((size, child) => size + child.size, 0));
    for (let i = 0; i < children.length; i++) {
        expect(tree.maximums[i]).toBe(tree.children[i]!.maximum);
        if (i) expect(order(tree.maximums[i - 1]!, tree.maximums[i]!)).toBe(-1);
        for (const node of children[i]!.nodes) nodes.add(node);
    }
    expect(tree.maximum).toBe(tree.children.at(-1)!.maximum);
    return { height: children[0]!.height + 1, size: tree.size, nodes };
}

test("one edit shares every untouched node in a retained 100k-entry tree", () => {
    let tree: BTree.BTree<Entry>;
    for (let key = 0; key < 100000; key++) tree = BTree.set(tree, { key, value: key }, order);
    const before = tree;
    const original = shape(before, order);
    tree = BTree.set(tree, { key: 50000, value: -1 }, order);
    const edited = shape(tree, order);
    expect([...edited.nodes].filter((node) => !original.nodes.has(node))).toHaveLength(original.height);
    expect(BTree.slice(before, 50000, 50001)).toEqual([{ key: 50000, value: 50000 }]);
    expect(BTree.slice(tree, 50000, 50001)).toEqual([{ key: 50000, value: -1 }]);
    expect(BTree.size(before)).toBe(100000);
    expect(BTree.size(tree)).toBe(100000);
});

test("splits, sibling borrowing, merges and root collapse retain all prior snapshots", () => {
    let tree: BTree.BTree<Entry>;
    const oracle = new Map<number, Entry>();
    for (let n = 0; n < 3000; n++) {
        const key = n % 2 ? 3000 - Math.ceil(n / 2) : n / 2;
        const entry = { key, value: n };
        tree = BTree.set(tree, entry, order);
        oracle.set(key, entry);
    }
    const snapshots: { tree: BTree.BTree<Entry>; expected: Entry[] }[] = [{ tree, expected: sorted(oracle) }];
    const keys = [...oracle.keys()].sort((a, b) => (a % 2) - (b % 2) || a - b);
    for (let n = 0; n < keys.length; n++) {
        tree = BTree.remove(tree, { key: keys[n]!, value: 0 }, order);
        oracle.delete(keys[n]!);
        if (n % 97 === 0) {
            expect([...BTree.values(tree)]).toEqual(sorted(oracle));
            shape(tree, order);
            snapshots.push({ tree, expected: sorted(oracle) });
        }
    }
    expect(tree).toBeUndefined();
    expect(BTree.remove(tree, { key: 0, value: 0 }, order)).toBeUndefined();
    for (const snapshot of snapshots) expect([...BTree.values(snapshot.tree)]).toEqual(snapshot.expected);
});

const generator = Arbitrary.schema(
    Schema.Struct({
        operations: Schema.Array(
            Schema.Struct({
                key: Schema.Int.check(Schema.isBetween({ minimum: -128, maximum: 1024 })),
                value: Schema.Int,
                remove: Schema.Boolean,
            })
        ),
        lower: Schema.Int.check(Schema.isBetween({ minimum: -140, maximum: 1030 })),
        upper: Schema.Int.check(Schema.isBetween({ minimum: -140, maximum: 1030 })),
        lowerOpen: Schema.Boolean,
        upperOpen: Schema.Boolean,
        descending: Schema.Boolean,
        limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 270 })),
    })
);
it.effect.prop(
    "persistent edits and rank windows match an independent Map and sorted-array oracle",
    [generator],
    ([input]) =>
        Effect.sync(() => {
            let tree: BTree.BTree<Entry>;
            const oracle = new Map<number, Entry>();
            for (let key = 0; key < 260; key++) {
                const item = { key, value: key };
                tree = BTree.set(tree, item, order);
                oracle.set(key, item);
            }
            for (const operation of input.operations) {
                const previous = tree;
                const before = sorted(oracle);
                if (operation.remove) {
                    tree = BTree.remove(tree, operation, order);
                    oracle.delete(operation.key);
                } else {
                    const entry = { key: operation.key, value: operation.value };
                    tree = BTree.set(tree, entry, order);
                    oracle.set(entry.key, entry);
                }
                expect([...BTree.values(previous)]).toEqual(before);
            }
            const entries = sorted(oracle);
            expect([...BTree.values(tree)]).toEqual(entries);
            shape(tree, order);
            const lower = Math.min(input.lower, input.upper),
                upper = Math.max(input.lower, input.upper);
            const start = BTree.rank(tree, (entry) => Order.Number(entry.key, lower), input.lowerOpen);
            const end = BTree.rank(tree, (entry) => Order.Number(entry.key, upper), !input.upperOpen);
            expect(start).toBe(
                entries.filter((entry) => (input.lowerOpen ? entry.key <= lower : entry.key < lower)).length
            );
            expect(end).toBe(
                entries.filter((entry) => (input.upperOpen ? entry.key < upper : entry.key <= upper)).length
            );
            let expected = entries.filter(
                (entry) =>
                    (input.lowerOpen ? entry.key > lower : entry.key >= lower) &&
                    (input.upperOpen ? entry.key < upper : entry.key <= upper)
            );
            if (input.descending) expected = expected.reverse();
            expect(BTree.slice(tree, start, end, input.descending, input.limit)).toEqual(
                expected.slice(0, input.limit)
            );
        }),
    { arbitrary: { runs: 200, size: 16, seed: "memory-cow-btree-v1" } }
);
