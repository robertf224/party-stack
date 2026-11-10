import type { Order } from "effect";

const maximum = 32;
const minimum = maximum / 2;
interface Leaf<A> {
    readonly kind: "leaf";
    readonly items: readonly A[];
    readonly size: number;
    readonly maximum: A;
}
interface Branch<A> {
    readonly kind: "branch";
    readonly children: readonly Node<A>[];
    readonly maximums: readonly A[];
    readonly size: number;
    readonly maximum: A;
}
type Node<A> = Leaf<A> | Branch<A>;
/** Immutable sorted entries. Comparator equality replaces the existing entry. */
export type BTree<A> = Node<A> | undefined;

const leaf = <A>(items: readonly A[]): Leaf<A> => ({
    kind: "leaf",
    items,
    size: items.length,
    maximum: items.at(-1)!,
});
const branch = <A>(children: readonly Node<A>[]): Branch<A> => ({
    kind: "branch",
    children,
    maximums: children.map((child) => child.maximum),
    size: children.reduce((size, child) => size + child.size, 0),
    maximum: children.at(-1)!.maximum,
});
const occupancy = <A>(node: Node<A>) => (node.kind === "leaf" ? node.items.length : node.children.length);

/** Lower-bound position, or upper-bound position when inclusive counts equality. */
function position<A>(items: readonly A[], compare: (item: A) => number, inclusive: boolean): number {
    let lo = 0,
        hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const order = compare(items[mid]!);
        if (order < 0 || (inclusive && order === 0)) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
function insert<A>(node: Node<A>, item: A, order: Order.Order<A>): { left: Node<A>; right?: Node<A> } {
    if (node.kind === "leaf") {
        const at = position(node.items, (value) => order(value, item), false);
        if (at < node.items.length && order(node.items[at]!, item) === 0) {
            if (node.items[at] === item) return { left: node };
            const items = node.items.slice();
            items[at] = item;
            return { left: leaf(items) };
        }
        const items = node.items.slice();
        items.splice(at, 0, item);
        return items.length <= maximum
            ? { left: leaf(items) }
            : { left: leaf(items.slice(0, minimum)), right: leaf(items.slice(minimum)) };
    }
    const at = Math.min(
        position(node.maximums, (value) => order(value, item), false),
        node.children.length - 1
    );
    const result = insert(node.children[at]!, item, order);
    if (result.left === node.children[at] && !result.right) return { left: node };
    const children = node.children.slice();
    children.splice(at, 1, result.left, ...(result.right ? [result.right] : []));
    return children.length <= maximum
        ? { left: branch(children) }
        : { left: branch(children.slice(0, minimum)), right: branch(children.slice(minimum)) };
}
export function set<A>(tree: BTree<A>, item: A, order: Order.Order<A>): BTree<A> {
    if (!tree) return leaf([item]);
    const result = insert(tree, item, order);
    return result.right ? branch([result.left, result.right]) : result.left;
}

function merge<A>(left: Node<A>, right: Node<A>): Node<A> {
    if (left.kind === "leaf" && right.kind === "leaf") return leaf([...left.items, ...right.items]);
    if (left.kind === "branch" && right.kind === "branch")
        return branch([...left.children, ...right.children]);
    throw new Error("BTree siblings must have the same height.");
}
/** Only the copied parent array is mutated; every replacement node owns arrays. */
function rebalance<A>(children: Node<A>[], at: number): void {
    const child = children[at]!;
    const left = children[at - 1],
        right = children[at + 1];
    if (left && occupancy(left) > minimum) {
        if (left.kind === "leaf" && child.kind === "leaf") {
            children[at - 1] = leaf(left.items.slice(0, -1));
            children[at] = leaf([left.items.at(-1)!, ...child.items]);
        } else if (left.kind === "branch" && child.kind === "branch") {
            children[at - 1] = branch(left.children.slice(0, -1));
            children[at] = branch([left.children.at(-1)!, ...child.children]);
        } else throw new Error("BTree siblings must have the same height.");
    } else if (right && occupancy(right) > minimum) {
        if (child.kind === "leaf" && right.kind === "leaf") {
            children[at] = leaf([...child.items, right.items[0]!]);
            children[at + 1] = leaf(right.items.slice(1));
        } else if (child.kind === "branch" && right.kind === "branch") {
            children[at] = branch([...child.children, right.children[0]!]);
            children[at + 1] = branch(right.children.slice(1));
        } else throw new Error("BTree siblings must have the same height.");
    } else if (left) children.splice(at - 1, 2, merge(left, child));
    else if (right) children.splice(at, 2, merge(child, right));
}
function removeNode<A>(node: Node<A>, item: A, order: Order.Order<A>): BTree<A> {
    if (node.kind === "leaf") {
        const at = position(node.items, (value) => order(value, item), false);
        if (at === node.items.length || order(node.items[at]!, item) !== 0) return node;
        if (node.items.length === 1) return undefined;
        const items = node.items.slice();
        items.splice(at, 1);
        return leaf(items);
    }
    const at = position(node.maximums, (value) => order(value, item), false);
    if (at === node.children.length) return node;
    const updated = removeNode(node.children[at]!, item, order);
    if (updated === node.children[at]) return node;
    const children = node.children.slice();
    if (updated) {
        children[at] = updated;
        if (occupancy(updated) < minimum && children.length > 1) rebalance(children, at);
    } else children.splice(at, 1);
    return children.length ? branch(children) : undefined;
}
export function remove<A>(tree: BTree<A>, item: A, order: Order.Order<A>): BTree<A> {
    if (!tree) return undefined;
    let result = removeNode(tree, item, order);
    while (result?.kind === "branch" && result.children.length === 1) result = result.children[0];
    return result;
}
export const size = <A>(tree: BTree<A>): number => tree?.size ?? 0;

/** Number of entries before a monotone boundary, optionally including equality. */
export function rank<A>(tree: BTree<A>, compare: (item: A) => number, inclusive = false): number {
    if (!tree) return 0;
    if (tree.kind === "leaf") return position(tree.items, compare, inclusive);
    const at = position(tree.maximums, compare, inclusive);
    let before = 0;
    for (let i = 0; i < at; i++) before += tree.children[i]!.size;
    return before + (at < tree.children.length ? rank(tree.children[at], compare, inclusive) : 0);
}
/** A rank slice visits only intersecting subtrees, not the entire sorted index. */
export function slice<A>(
    tree: BTree<A>,
    start: number,
    end: number,
    descending = false,
    limit?: number
): A[] {
    let from = Math.max(0, start),
        to = Math.min(size(tree), end);
    if (limit !== undefined) {
        if (descending) from = Math.max(from, to - limit);
        else to = Math.min(to, from + limit);
    }
    const result: A[] = [];
    const visit = (node: Node<A>, base: number): void => {
        if (node.kind === "leaf") {
            for (let i = Math.max(0, from - base); i < Math.min(node.size, to - base); i++)
                result.push(node.items[i]!);
        } else {
            let offset = base;
            for (const child of node.children) {
                if (offset >= to) break;
                if (offset + child.size > from) visit(child, offset);
                offset += child.size;
            }
        }
    };
    if (tree && from < to) visit(tree, 0);
    return descending ? result.reverse() : result;
}
export function* values<A>(tree: BTree<A>): IterableIterator<A> {
    if (!tree) return;
    if (tree.kind === "leaf") yield* tree.items;
    else for (const child of tree.children) yield* values(child);
}
