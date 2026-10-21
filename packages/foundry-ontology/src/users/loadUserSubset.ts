import { Users, type User } from "@osdk/foundry.admin";
import { applyLensToObject, mapTargetPathToSourceWithLens, type Lens } from "@party-stack/ontology-spec";
import { evaluateQuery, type Predicate, type Query } from "@party-stack/ontology-storage";
import { isField } from "@party-stack/ontology-storage/tables";
import { chunk } from "../utils/chunk.js";
import { foundryUserProfilePictureAttachment } from "./foundryUser.js";
import type { Client } from "@party-stack/foundry-client";
import type { BackendSnapshot, SourceQueryPlan } from "@party-stack/ontology-backend";

type Selection =
    | { type: "getBatch"; ids: string[]; paths: number[][] }
    | { type: "search"; term: string; paths: number[][] };

/** Choose only a safe candidate set. Every response is checked against the full query. */
function select(predicate: Predicate, lens: Lens, path: number[] = []): Selection | undefined {
    if (predicate.op === "and" || predicate.op === "or") {
        const children = predicate.predicates.map((child, index) => select(child, lens, [...path, index]));
        if (predicate.op === "and")
            return children.find((child) => child?.type === "getBatch") ?? children.find(Boolean);
        if (children.some((child) => !child)) return;
        if (children.every((child) => child?.type === "getBatch"))
            return {
                type: "getBatch",
                ids: [...new Set(children.flatMap((child) => child.ids))],
                paths: children.flatMap((child) => child.paths),
            };
        const first = children[0];
        if (
            first?.type === "search" &&
            children.every((child) => child?.type === "search" && child.term === first.term)
        )
            return { ...first, paths: children.flatMap((child) => child!.paths) };
        return;
    }
    if (predicate.op === "not") return;
    const left =
        predicate.op === "eq" && !isField(predicate.left) && isField(predicate.right)
            ? predicate.right
            : predicate.left;
    const right =
        predicate.op === "eq" && left === predicate.right
            ? predicate.left
            : predicate.op !== "in"
              ? predicate.right
              : undefined;
    if (!isField(left)) return;
    const source = mapTargetPathToSourceWithLens(left.path, lens).join(".");
    if (source === "id") {
        if (predicate.op === "eq" && typeof right === "string")
            return { type: "getBatch", ids: [right], paths: [path] };
        if (predicate.op === "in" && predicate.values.every((value) => typeof value === "string"))
            return { type: "getBatch", ids: [...new Set(predicate.values)], paths: [path] };
    }
    if (
        (predicate.op === "like" || predicate.op === "ilike") &&
        typeof right === "string" &&
        ["username", "givenName", "familyName"].includes(source)
    ) {
        // Admin search is case-insensitive prefix matching across all name fields.
        // Complex patterns must not become a narrower, incorrect search term.
        const term = right.slice(0, -1);
        if (right.endsWith("%") && term.length > 0 && !/[%_\\]/.test(term))
            return { type: "search", term, paths: [path] };
    }
}

function placements(
    predicate: Predicate | undefined,
    selection: Selection | undefined
): SourceQueryPlan["predicates"] {
    const selected = new Set(selection?.paths.map((path) => JSON.stringify(path)));
    const result: SourceQueryPlan["predicates"][number][] = [];
    const visit = (predicate: Predicate, path: number[]) => {
        if (predicate.op === "and" || predicate.op === "or")
            predicate.predicates.forEach((child, index) => visit(child, [...path, index]));
        else if (predicate.op === "not") visit(predicate.predicate, [...path, 0]);
        else
            result.push({
                path,
                execution: selected.has(JSON.stringify(path))
                    ? selection?.type === "getBatch"
                        ? "source"
                        : "candidate"
                    : "adapter",
            });
    };
    if (predicate) visit(predicate, []);
    return result;
}

export async function loadUserSubset(
    client: Client,
    lens: Lens,
    query: Query,
    signal: AbortSignal
): Promise<BackendSnapshot> {
    signal.throwIfAborted();
    evaluateQuery([], query);
    if (query.limit === 0) return { rows: [], complete: true, fetchedRows: 0 };
    const requestClient = {
        ...client,
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
            client.fetch(input, {
                ...init,
                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            }),
    };
    const selection = query.where ? select(query.where, lens) : undefined;
    const users: User[] = [];
    const batches = selection?.type === "getBatch" ? chunk(selection.ids, 500) : undefined;
    if (batches) {
        for (const ids of batches) {
            signal.throwIfAborted();
            const response = await Users.getBatch(
                requestClient,
                ids.map((userId) => ({ userId }))
            );
            users.push(...Object.values(response.data));
        }
    } else {
        let pageToken: string | undefined;
        do {
            signal.throwIfAborted();
            const page =
                selection?.type === "search"
                    ? await Users.search(requestClient, {
                          where: { type: "queryString", value: selection.term },
                          pageToken,
                      })
                    : await Users.list(requestClient, { pageToken });
            users.push(...page.data);
            pageToken = page.nextPageToken;
        } while (pageToken !== undefined);
    }
    signal.throwIfAborted();
    const rows = users.map((user) => ({
        key: user.id,
        value: applyLensToObject(
            { ...user, profilePicture: foundryUserProfilePictureAttachment(user.id) },
            lens
        ),
    }));
    return {
        rows: evaluateQuery(rows, query),
        complete: true,
        fetchedRows: users.length,
        pushdown: {
            source: "Foundry users",
            predicates: placements(query.where, selection),
            sorting: query.orderBy?.length ? "adapter" : "none",
            pagination:
                query.limit !== undefined || query.offset !== undefined || query.after ? "adapter" : "none",
            rechecksFilter: Boolean(query.where),
            native: {
                language: "json",
                text: JSON.stringify(
                    batches
                        ? {
                              operation: "Users.getBatch",
                              batches: batches.map((ids) => ids.map((userId) => ({ userId }))),
                          }
                        : selection?.type === "search"
                          ? {
                                operation: "Users.search",
                                where: { type: "queryString", value: selection.term },
                            }
                          : { operation: "Users.list" },
                    null,
                    2
                ),
            },
        },
    };
}
