import { BackendError } from "@party-stack/ontology-backend";
import { actionExpressions } from "@party-stack/ontology-backend/actions";
import { getAtPath } from "@party-stack/ontology-spec/utils";
import { eq } from "@tanstack/db";
import { Effect } from "effect";
import type { OntologyReadTx } from "./mutators/types.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OwnedReadTransaction } from "@party-stack/ontology-backend/owned";
import type { Expression, OntologyIR } from "@party-stack/ontology-spec";
import type { Field } from "@party-stack/ontology-storage";
export type ExpressionReplay = NonNullable<ActionRequest["replay"]>;
const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "expression.evaluate",
              kind: "Internal",
              retryable: false,
              message: "Expression evaluation failed.",
              cause,
          });
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure });
/** Compatibility with the application's TanStack query authoring interface; execution is shared below. */
const reader = (ir: OntologyIR, tx: OntologyReadTx): OwnedReadTransaction => ({
    get: (name, key) =>
        attempt(() =>
            tx.query((query, objects) =>
                query
                    .from({ object: objects[name]! })
                    .where(({ object }) =>
                        eq(object[ir.objectTypes.find((t) => t.name === name)!.primaryKey], key)
                    )
                    .findOne()
            )
        ),
    loadSubset: (name, scan) =>
        Effect.gen(function* () {
            const where = scan?.where;
            if (
                where &&
                (where.op !== "eq" ||
                    !where.left ||
                    typeof where.left !== "object" ||
                    !("_tag" in where.left))
            )
                return yield* new BackendError({
                    operation: "expression.read",
                    kind: "NotImplemented",
                    retryable: false,
                    message: "The authoring read bridge requires an equality lookup.",
                });
            const rows = yield* attempt(() =>
                tx.query<Record<string, unknown>[]>((query, objects) => {
                    const source = query.from({ object: objects[name]! });
                    const filtered =
                        where?.op === "eq" &&
                        where.left &&
                        typeof where.left === "object" &&
                        "_tag" in where.left
                            ? source.where(({ object }) =>
                                  eq(getAtPath(object, (where.left as Field).path), where.right)
                              )
                            : source;
                    return scan?.limit === undefined
                        ? filtered
                        : filtered
                              .orderBy(
                                  ({ object }) =>
                                      object[ir.objectTypes.find((t) => t.name === name)!.primaryKey]
                              )
                              .limit(scan.limit);
                })
            );
            const pk = ir.objectTypes.find((t) => t.name === name)!.primaryKey;
            return rows.map((value) => ({ key: value[pk] as string | number, value }));
        }),
});
export const evaluateExpression = (options: {
    readonly ir: OntologyIR;
    readonly actionTypeName: string;
    readonly expression: Expression;
    readonly replay?: ExpressionReplay;
    readonly location?: readonly (string | number)[];
    readonly resolveParameter: (name: string) => Promise<unknown>;
    readonly context: Record<string, unknown>;
    readonly tx: OntologyReadTx;
}): Promise<unknown> =>
    Effect.runPromise(
        actionExpressions({
            ir: options.ir,
            tx: reader(options.ir, options.tx),
            request: {
                id: options.replay?.seed ?? "expression",
                name: options.actionTypeName,
                parameters: {},
                replay: options.replay,
            },
            context: options.context,
            resolveParameter: (name) => attempt(() => options.resolveParameter(name)),
        }).evaluate(options.expression, options.location)
    );
export const resolveActionParameters = (options: {
    readonly ir: OntologyIR;
    readonly actionTypeName: string;
    readonly initialParameters: Record<string, unknown>;
    readonly replay?: ExpressionReplay;
    readonly context: Record<string, unknown>;
    readonly tx: OntologyReadTx;
}): Promise<Record<string, unknown>> =>
    Effect.runPromise(
        actionExpressions({
            ir: options.ir,
            tx: reader(options.ir, options.tx),
            request: {
                id: options.replay?.seed ?? "resolve",
                name: options.actionTypeName,
                parameters: options.initialParameters,
                replay: options.replay,
            },
            context: options.context,
        }).resolve
    );
