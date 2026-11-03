import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import * as q from "@party-stack/ontology-spec/query";
import { QuerySchema } from "@party-stack/ontology-storage";
import { Effect, Predicate as EffectPredicate, Schema } from "effect";
import { BackendError } from "./errors.js";
import { queryExecutor } from "./query.js";
import type { OntologyIR, Expression } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";
import type { Operand, Predicate, Query, Field } from "@party-stack/ontology-storage";

export interface CompiledSubset {
    readonly objectType: string;
    readonly query?: Query;
}
export { ObjectSubsetSchema, ObjectSelectionSchema } from "./subsetSchema.js";

/** Infrastructure adapter for existing physical provider/transaction readers. */
export const objectSubset = (objectType: string, scan: Query = {}, binding = "row"): ObjectSubset => {
    const operand = (v: Operand): Expression =>
        v && typeof v === "object" && "_tag" in v && v._tag === "Field"
            ? q.field(binding, ...(v as Field).path)
            : q.literal(v);
    const predicate = (p: Predicate): Expression => {
        if (p.op === "and" || p.op === "or") return q[p.op](...p.predicates.map(predicate));
        if (p.op === "not") return q.not(predicate(p.predicate));
        if (p.op === "in") return q.inArray(operand(p.left), q.literal([...p.values]));
        return q[p.op](operand(p.left), operand(p.right));
    };
    return {
        from: { source: { objectType }, binding },
        ...(scan.where ? { where: predicate(scan.where) } : {}),
        ...(scan.orderBy
            ? {
                  orderBy: scan.orderBy.map((o) => ({
                      expression: operand(o.field),
                      direction: o.direction,
                      nulls: o.nulls,
                  })),
              }
            : {}),
        ...(scan.limit !== undefined || scan.offset !== undefined || scan.after !== undefined
            ? {
                  page: {
                      limit: scan.limit,
                      offset: scan.offset,
                      after: scan.after ? { values: [...scan.after.values], key: scan.after.key } : undefined,
                  },
              }
            : {}),
    };
};
/** Lower a source-bound spec subset at the engine/provider boundary, never at the public demand API. */
export const compileObjectSubset = Effect.fnUntraced(function* (
    ir: OntologyIR,
    subset: ObjectSubset,
    context?: Record<string, unknown>
): Effect.fn.Return<CompiledSubset, BackendError> {
    if (EffectPredicate.isObject(subset) && Object.hasOwn(subset, "select"))
        return yield* new BackendError({
            operation: "subset.compile",
            kind: "NotImplemented",
            retryable: false,
            message: "Query selections require query-result demand, which is not implemented yet.",
        });
    const document = yield* Schema.decodeUnknownEffect(QueryDocumentSchema)({
        select: [q.sub("objects", { ...subset, select: [] })],
    }).pipe(
        Effect.mapError(
            (cause) =>
                new BackendError({
                    operation: "subset.compile",
                    kind: "InvalidRequest",
                    retryable: false,
                    message: "Invalid object subset.",
                    cause,
                })
        )
    );
    const selection = document.select[0]!;
    if (selection.kind !== "sub")
        return yield* new BackendError({
            operation: "subset.compile",
            kind: "InvalidRequest",
            retryable: false,
            message: "Invalid object subset selection.",
        });
    subset = selection.value.query;
    const unsupported = () =>
        new BackendError({
            operation: "subset.compile",
            kind: "NotImplemented",
            retryable: false,
            message:
                "This subset requires query-result demand; only exact object predicates and field ordering can be demanded directly.",
        });
    const issues = yield* Effect.try({
        try: () => q.validateQueryDocument(ir, document),
        catch: (cause) =>
            new BackendError({
                operation: "subset.compile",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Invalid ontology query environment.",
                cause,
            }),
    });
    if (issues.length || subset.from.source.ontology)
        return yield* new BackendError({
            operation: "subset.compile",
            kind: "InvalidRequest",
            retryable: false,
            message: "Invalid object subset.",
            issues,
        });
    const reader = { ir, loadSubset: () => Effect.fail(unsupported()) };
    const executor = queryExecutor({ reader, context });
    let where;
    if (subset.where) {
        const lowered = yield* executor.lower(subset.where, subset.from, new Map());
        if (!lowered.exact) return yield* unsupported();
        where = lowered.where;
    }
    const orderBy = [];
    for (const order of subset.orderBy ?? []) {
        const e = order.expression;
        if (
            e.kind !== "getAt" ||
            e.value.source.kind !== "localReference" ||
            e.value.source.value.name !== subset.from.binding
        )
            return yield* unsupported();
        orderBy.push({
            field: { _tag: "Field" as const, path: e.value.path },
            direction: order.direction,
            nulls: order.nulls,
        });
    }
    const query = yield* Schema.decodeUnknownEffect(QuerySchema)({
        where,
        ...(orderBy.length ? { orderBy } : {}),
        ...subset.page,
    }).pipe(
        Effect.mapError(
            (cause) =>
                new BackendError({
                    operation: "subset.compile",
                    kind: "InvalidRequest",
                    retryable: false,
                    message: "Invalid subset window or operands.",
                    cause,
                })
        )
    );
    return {
        objectType: subset.from.source.objectType,
        ...(Object.values(query).some((value) => value !== undefined) ? { query } : {}),
    };
});

export { resolveSubsetSnapshot, coversSubset } from "./fulfillment.js";
