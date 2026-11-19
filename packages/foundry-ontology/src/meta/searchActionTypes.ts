import { ActionTypesV2 } from "@osdk/foundry.ontologies";
import { BackendError } from "@party-stack/ontology-backend";
import {
    applyQuery,
    compareRows,
    eq,
    filterField,
    filterOperand,
    inValues,
} from "@party-stack/ontology-storage/tables";
import { toFoundryActionTypeName, toOntologyActionTypeName } from "../utils/actionTypeName.js";
import type { ActionTypeSearchJsonQueryV2, ActionTypeV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { Filter, Query, Row, Scalar } from "@party-stack/ontology-storage";

/** Storage LIKE has no escape syntax: `%` and `_` are wildcards and every other character,
 * `\` included, is literal. Each run between wildcards must appear in a match, so the runs
 * are a sound `contains` prefilter. Backslashes split runs too, so they never reach Foundry. */
const LIKE_SEPARATORS = /[%_\\]/;

/** Lucene's default English stop set. Foundry drops these words from a `contains` term, so a
 * term made only of them matches nothing, even though `at` is a substring of "Create". */
const STOPWORDS = new Set(
    "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(
        " "
    )
);

/** Foundry splits a `contains` term into words, drops stopwords, and matches a row when any
 * remaining word appears inside one of its words, ignoring case. A term with at least one
 * remaining word therefore covers every case-insensitive substring match; other terms are
 * kept local. Checked against Foundry's API. */
function containsTerm(term: string): string | undefined {
    const words = term
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    return words.some((word) => !STOPWORDS.has(word)) ? term : undefined;
}

/** A superset prefilter for Foundry's action type search; the engine rechecks every row.
 *
 * `name` is the camelCase form of Foundry's kebab-case API name, and Foundry searches only the
 * kebab form. A case-sensitive term's capitals mark its word boundaries, so `like` converts
 * soundly; `ilike` folds them away (`addassets` cannot become `add-assets`) and stays local. */
export function actionTypeSearchQuery(predicate?: Filter): ActionTypeSearchJsonQueryV2 | undefined {
    if (!predicate) return;
    if (predicate.kind === "and" || predicate.kind === "or") {
        const children = predicate.value.expressions.map(actionTypeSearchQuery);
        if (predicate.kind === "or" && children.some((child) => child === undefined)) return;
        const supported = children.filter((child) => child !== undefined);
        return supported.length === 1
            ? supported[0]
            : supported.length
              ? { type: predicate.kind, value: supported }
              : undefined;
    }
    if (predicate.kind === "in") {
        const left = predicate.value.left;
        const children = inValues(predicate).map((value) => actionTypeSearchQuery(eq(left, value as Scalar)));
        if (children.every((child) => child !== undefined)) return { type: "or", value: children };
        return;
    }
    if (predicate.kind !== "eq" && predicate.kind !== "like" && predicate.kind !== "ilike") return;
    const left = filterOperand(predicate.value.left);
    const right = filterOperand(predicate.value.right);
    const [ref, other] = left?.kind === "field" ? [left, right] : [right, left];
    if (ref?.kind !== "field" || other?.kind !== "literal" || typeof other.value !== "string") return;
    const value = other.value;
    const field = ref.field.path.join(".");
    if (predicate.kind === "eq" && field === "id") return { type: "actionTypeRid", value };
    if (field !== "name" && field !== "displayName") return;
    const type = field === "name" ? ("actionTypeApiName" as const) : ("actionTypeDisplayName" as const);
    if (predicate.kind === "eq")
        return {
            type,
            value: { type: "exact", value: field === "name" ? toFoundryActionTypeName(value) : value },
        };
    if (field === "name" && predicate.kind === "ilike") return;
    const children: ActionTypeSearchJsonQueryV2[] = value
        .split(LIKE_SEPARATORS)
        .map((term) => containsTerm(field === "name" ? toFoundryActionTypeName(term) : term))
        .filter((term) => term !== undefined)
        .map((term) => ({ type, value: { type: "contains", value: term } }));
    return children.length <= 1 ? children[0] : { type: "and", value: children };
}

/** The ActionType fields a search result carries, as `convertFoundryMetaActionType` writes them. */
export function actionTypeSearchFields(actionType: ActionTypeV2) {
    return {
        id: actionType.rid,
        name: toOntologyActionTypeName(actionType.apiName),
        displayName: actionType.displayName ?? actionType.apiName,
    };
}
const SEARCH_FIELDS = new Set(["id", "name", "displayName"]);

/** Whether every row field the filter reads is available before full metadata loads. */
function readsSearchFields(node: unknown): boolean {
    const field = filterField(node);
    if (field) return field.path.length === 1 && SEARCH_FIELDS.has(field.path[0]!);
    if (Array.isArray(node)) return node.every(readsSearchFields);
    if (node !== null && typeof node === "object") return Object.values(node).every(readsSearchFields);
    return true;
}

export interface ActionTypeWindow {
    readonly direction: "asc" | "desc";
    /** Leading rows to fulfill: the request's offset plus its limit. */
    readonly size: number;
}

/** A request whose leading window Foundry can produce: ordered by displayName alone, with a
 * filter the adapter can recheck from search results. Without an order the engine ranks by
 * primary key, which Foundry cannot sort by; keyset cursors stay on the full scan. */
export function planActionTypeWindow(query: Query | undefined): ActionTypeWindow | undefined {
    if (query?.limit === undefined || query.after) return;
    const [order, ...rest] = query.orderBy ?? [];
    if (!order || rest.length || order.field.path.length !== 1 || order.field.path[0] !== "displayName")
        return;
    if (query.where && !readsSearchFields(query.where)) return;
    return { direction: order.direction ?? "asc", size: (query.offset ?? 0) + query.limit };
}

const MAX_PAGE_SIZE = 100;
const MIN_PAGE_SIZE = 10;

/**
 * Reads Foundry's displayName-ordered search until the request's leading window is decided,
 * rechecking the filter locally. Returns every matching row up to `window.size`, plus rows
 * tied with the last one so the engine can break ties by primary key itself.
 *
 * Sound when Foundry's prefilter is a superset (as the unwindowed path already assumes) and
 * its displayName order is the engine's UTF-16 order. Every fetched row is checked against
 * the engine's comparator; on the first inversion this returns undefined so the caller can
 * fall back to a full scan.
 */
export async function searchActionTypeWindow(
    client: OntologyClient,
    query: Query,
    window: ActionTypeWindow
): Promise<{ actions: ActionTypeV2[]; fetched: number } | undefined> {
    const actions: ActionTypeV2[] = [];
    let fetched = 0;
    if (window.size === 0) return { actions, fetched };
    const where = actionTypeSearchQuery(query.where);
    const order: Query = { orderBy: query.orderBy };
    const visited = new Set<string>();
    let previous: Row<unknown> | undefined;
    let boundary: Row<unknown> | undefined;
    let pageToken: string | undefined;
    for (;;) {
        const page = await ActionTypesV2.search(
            client,
            client.ontologyRid,
            {
                where,
                orderBy: { field: "actionTypeDisplayName", direction: window.direction },
                pageSize: Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, window.size - actions.length + 1)),
                pageToken,
                fuzziness: { type: "off" },
            },
            { preview: true }
        );
        for (const actionType of page.data) {
            fetched++;
            // A constant key makes equal display names compare equal: Foundry's tie order is its own.
            const row = { key: 0, value: actionTypeSearchFields(actionType) };
            if (previous && compareRows(previous, row, order) > 0) return;
            previous = row;
            if (boundary && compareRows(boundary, row, order) !== 0) return { actions, fetched };
            if (applyQuery([row], { where: query.where }).length) {
                actions.push(actionType);
                if (actions.length === window.size) boundary = row;
            }
        }
        pageToken = page.nextPageToken;
        if (pageToken === undefined) return { actions, fetched };
        if (visited.has(pageToken))
            throw new BackendError({
                operation: "provider.pagination",
                kind: "InvalidResponse",
                message: "The provider repeated a pagination cursor.",
                retryable: false,
            });
        visited.add(pageToken);
    }
}
