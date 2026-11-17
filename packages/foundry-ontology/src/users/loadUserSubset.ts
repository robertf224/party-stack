import { Users, type User } from "@osdk/foundry.admin";
import { BackendError } from "@party-stack/ontology-backend";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { applyLensToObject, mapTargetPathToSourceWithLens, type Lens } from "@party-stack/ontology-spec";
import {
    evaluateQuery,
    filterOperand,
    inValues,
    type Filter,
    type Query,
} from "@party-stack/ontology-storage";
import { Schema, Redacted } from "effect";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { chunk } from "../utils/chunk.js";
import { foundryUserProfilePictureAttachment } from "./foundryUser.js";
import type { Client } from "@party-stack/foundry-client";
import type { BackendSnapshot, SourceQueryPlan } from "@party-stack/ontology-backend";

const UserIdentity = Schema.Struct({ id: Schema.String });
const UserPage = Schema.Struct({
    data: Schema.Array(UserIdentity),
    nextPageToken: Schema.optional(Schema.String),
});
const UserBatch = Schema.Struct({ data: Schema.Record(Schema.String, UserIdentity) });
function checked<A>(schema: Schema.Decoder<unknown>, value: A): A {
    try {
        Schema.decodeUnknownSync(schema)(value);
        return value;
    } catch (cause) {
        throw new BackendError({
            operation: "foundry.users.loadSubset",
            kind: "InvalidResponse",
            message: "Foundry returned an invalid user response.",
            retryable: false,
            cause: Redacted.make(cause),
        });
    }
}

type Selection =
    | { type: "getBatch"; ids: string[]; paths: number[][] }
    | { type: "search"; term: string; paths: number[][] };

/** Choose only a safe candidate set. Every response is checked against the full query. */
function select(predicate: Filter, lens: Lens, path: number[] = []): Selection | undefined {
    if (predicate.kind === "and" || predicate.kind === "or") {
        const children = predicate.value.expressions.map((child, index) =>
            select(child, lens, [...path, index])
        );
        if (predicate.kind === "and")
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
    if (
        predicate.kind !== "eq" &&
        predicate.kind !== "in" &&
        predicate.kind !== "like" &&
        predicate.kind !== "ilike"
    )
        return;
    let left = filterOperand(predicate.value.left);
    let right = filterOperand(predicate.value.right);
    if (predicate.kind === "eq" && left?.kind !== "field" && right?.kind === "field")
        [left, right] = [right, left];
    if (left?.kind !== "field") return;
    const value = right?.kind === "literal" ? right.value : undefined;
    const source = mapTargetPathToSourceWithLens(left.field.path, lens).join(".");
    if (source === "id") {
        if (predicate.kind === "eq" && typeof value === "string")
            return { type: "getBatch", ids: [value], paths: [path] };
        const values = predicate.kind === "in" ? inValues(predicate) : undefined;
        if (values?.every((value) => typeof value === "string"))
            return { type: "getBatch", ids: [...new Set(values)], paths: [path] };
    }
    if (
        (predicate.kind === "like" || predicate.kind === "ilike") &&
        typeof value === "string" &&
        ["username", "givenName", "familyName"].includes(source)
    ) {
        // Admin search is case-insensitive prefix matching across all name fields.
        // Complex patterns must not become a narrower, incorrect search term.
        const term = value.slice(0, -1);
        if (value.endsWith("%") && term.length > 0 && !/[%_\\]/.test(term))
            return { type: "search", term, paths: [path] };
    }
}

function placements(
    predicate: Filter | undefined,
    selection: Selection | undefined
): SourceQueryPlan["predicates"] {
    const selected = new Set(selection?.paths.map((path) => JSON.stringify(path)));
    const result: SourceQueryPlan["predicates"][number][] = [];
    const visit = (predicate: Filter, path: number[]) => {
        if (predicate.kind === "and" || predicate.kind === "or")
            predicate.value.expressions.forEach((child, index) => visit(child, [...path, index]));
        else if (predicate.kind === "not") visit(predicate.value.expression, [...path, 0]);
        else
            result.push({
                path,
                execution: selected.has(JSON.stringify(path))
                    ? selection?.type === "getBatch"
                        ? "source"
                        : "candidate"
                    : "engine",
            });
    };
    if (predicate) visit(predicate, []);
    return result;
}

export async function loadUserSubset(
    client: Client,
    objectType: string,
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
            checked(UserBatch, response);
            users.push(...Object.values(response.data));
        }
    } else {
        users.push(
            ...(await AsyncIterable.toArray(
                AsyncIterable.fromPagination(
                    async (_pageSize, pageToken: string | undefined) => {
                        signal.throwIfAborted();
                        const page =
                            selection?.type === "search"
                                ? await Users.search(requestClient, {
                                      where: { type: "queryString", value: selection.term },
                                      pageToken,
                                  })
                                : await Users.list(requestClient, { pageToken });
                        return checked(UserPage, page);
                    },
                    (page) => page.nextPageToken,
                    (page) => page.data,
                    500
                )
            ))
        );
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
        rows,
        fulfilledSubset: objectSubset(objectType, selection ? { where: query.where } : {}),
        complete: true,
        fetchedRows: users.length,
        pushdown: {
            source: "Foundry users",
            predicates: placements(query.where, selection),
            sorting: query.orderBy?.length ? "engine" : "none",
            pagination:
                query.limit !== undefined || query.offset !== undefined || query.after ? "engine" : "none",
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
