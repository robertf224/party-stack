import { evaluateQuery, filterOperand, inValues } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Redacted, Schema } from "effect";
import { BackendError } from "./errors.js";
import { compileObjectSubset } from "./subset.js";
import { BackendSnapshotSchema } from "./index.js";
import type { BackendSnapshot } from "./index.js";
import type { CompiledSubset } from "./subset.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Filter, Query } from "@party-stack/ontology-storage";

const codec = Table.make<unknown>({ name: "subset-fulfillment" });
const same = (left: unknown, right: unknown) => codec.encode(left) === codec.encode(right);
const windowed = (query: Query) =>
    query.limit !== undefined || Boolean(query.offset) || query.after !== undefined;

/** Sound, deliberately small implication rules for declared coverage; no data-dependent inference. */
function implies(request: Filter | undefined, fulfilled: Filter | undefined): boolean {
    if (!fulfilled) return true;
    if (!request) return false;
    if (same(request, fulfilled)) return true;
    if (request.kind === "or") return request.value.expressions.every((child) => implies(child, fulfilled));
    if (fulfilled.kind === "and")
        return fulfilled.value.expressions.every((child) => implies(request, child));
    if (request.kind === "and" && request.value.expressions.some((child) => implies(child, fulfilled)))
        return true;
    if (fulfilled.kind === "or" && fulfilled.value.expressions.some((child) => implies(request, child)))
        return true;
    if (fulfilled.kind === "in") {
        const allowed = inValues(fulfilled);
        if (request.kind === "in" && same(request.value.left, fulfilled.value.left))
            return inValues(request).every((value) => allowed.some((other) => same(value, other)));
        if (request.kind === "eq") {
            const left = filterOperand(request.value.left),
                right = filterOperand(request.value.right);
            const [field, value] =
                left?.kind === "field" ? [request.value.left, right] : [request.value.right, left];
            if (
                filterOperand(field)?.kind === "field" &&
                value?.kind === "literal" &&
                same(field, fulfilled.value.left)
            )
                return allowed.some((other) => same(value.value, other));
        }
    }
    return false;
}

/** A windowed source can supply a wider prefix of the same ordered/filtered result. */
export function coversSubset(request: CompiledSubset, fulfilled: CompiledSubset): boolean {
    if (request.objectType !== fulfilled.objectType) return false;
    const wanted = request.query ?? {},
        actual = fulfilled.query ?? {};
    if (!windowed(actual)) return implies(wanted.where, actual.where);
    if (
        !same(wanted.where, actual.where) ||
        !same(wanted.orderBy ?? [], actual.orderBy ?? []) ||
        !same(wanted.after, actual.after)
    )
        return false;
    const delta = (wanted.offset ?? 0) - (actual.offset ?? 0);
    if (delta < 0) return false;
    return actual.limit === undefined || (wanted.limit !== undefined && delta + wanted.limit <= actual.limit);
}

/** Normalize exactly once at a consumer boundary; provider windows must not be applied twice. */
export const resolveSubsetSnapshot = Effect.fnUntraced(function* (
    ir: OntologyIR,
    request: ObjectSubset,
    snapshot: BackendSnapshot,
    context?: Record<string, unknown>
) {
    snapshot = yield* Schema.decodeUnknownEffect(BackendSnapshotSchema)(snapshot).pipe(
        Effect.mapError(
            (cause) =>
                new BackendError({
                    operation: "loadSubset",
                    kind: "InvalidResponse",
                    message: "The provider returned an invalid snapshot.",
                    retryable: false,
                    cause: Redacted.make(cause),
                })
        )
    );
    const requested = yield* compileObjectSubset(ir, request, context);
    const fulfilled = snapshot.fulfilledSubset
        ? yield* compileObjectSubset(ir, snapshot.fulfilledSubset, context).pipe(
              Effect.mapError(
                  (cause) =>
                      new BackendError({
                          operation: "loadSubset",
                          kind: "InvalidResponse",
                          message: "The provider reported an invalid fulfilled subset.",
                          retryable: false,
                          cause: Redacted.make(cause),
                      })
              )
          )
        : requested;
    return yield* Effect.try({
        try: () => {
            if (!coversSubset(requested, fulfilled))
                throw new Error("The fulfilled subset does not cover the request.");
            const primaryKey = ir.objectTypes.find((type) => type.name === requested.objectType)!.primaryKey;
            const keys = new Set<string | number>();
            for (const row of snapshot.rows) {
                if (row.value[primaryKey] !== row.key || keys.has(row.key))
                    throw new Error("Invalid or duplicate snapshot identity.");
                keys.add(row.key);
            }
            const query = requested.query ?? {};
            const actual = fulfilled.query ?? {};
            // Rows from an explicitly fulfilled window have already skipped its offset.
            const requestedQuery = {
                ...query,
                offset: Math.max(0, (query.offset ?? 0) - (actual.offset ?? 0)),
            };
            const rows = evaluateQuery(snapshot.rows, requestedQuery);
            return {
                requested,
                fulfilled,
                fulfilledRows: evaluateQuery(snapshot.rows, { ...actual, offset: 0 }),
                snapshot: { ...snapshot, fulfilledSubset: undefined, rows },
            };
        },
        catch: (cause) =>
            new BackendError({
                operation: "loadSubset",
                kind: "InvalidResponse",
                retryable: false,
                message: "The provider returned an incompatible subset snapshot.",
                cause: Redacted.make(cause),
            }),
    });
});
