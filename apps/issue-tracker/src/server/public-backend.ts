import { applyLensToObject, o } from "@party-stack/ontology";
import { BackendError, type OntologyBackendService } from "@party-stack/ontology-backend";
import { Effect, Schema } from "effect";
import type { OntologyIR } from "@party-stack/ontology";
import type { Predicate, Query } from "@party-stack/ontology-storage";

/** The demo's public schema is a projection of its complete server schema.
 * Apply that projection to snapshots AND the journal before granting full-view replication.
 */
export function publicBackend(backend: OntologyBackendService, ir: OntologyIR): OntologyBackendService {
    const project = Object.fromEntries(
        ir.objectTypes.map((object) => [
            object.name,
            (row: Record<string, unknown>) =>
                applyLensToObject(row, {
                    operations: [
                        o.LensOp.select({ properties: object.properties.map((property) => property.name) }),
                    ],
                }),
        ])
    );
    const rejected = () =>
        new BackendError({
            operation: "public-view",
            kind: "ValidationFailed",
            message: "Operation is outside the public ontology view.",
            retryable: false,
        });
    const check = (name: string, query?: Query) =>
        Effect.try({
            try: () => {
                const object = ir.objectTypes.find((object) => object.name === name);
                if (!object) throw rejected();
                const allowed = new Set(object.properties.map((property) => property.name));
                const field = (operand: unknown) => {
                    if (isField(operand) && !allowed.has(operand.path[0]!)) throw rejected();
                };
                const predicate = (value: Predicate): void => {
                    if (value.op === "and" || value.op === "or") return value.predicates.forEach(predicate);
                    if (value.op === "not") return predicate(value.predicate);
                    field(value.left);
                    if ("right" in value) field(value.right);
                };
                if (query?.where) predicate(query.where);
                query?.orderBy?.forEach((order) => field(order.field));
            },
            catch: () => rejected(),
        });
    const call = <A>(allowed: boolean, effect: Effect.Effect<A, BackendError>) =>
        allowed ? effect : Effect.fail(rejected());
    return {
        name: backend.name,
        sourceId: backend.sourceId,
        supportsIdempotency: backend.supportsIdempotency,
        loadSubset: (subset) =>
            Effect.gen(function* () {
                yield* check(subset.objectType, subset.query);
                const snapshot = yield* backend.loadSubset(subset);
                return {
                    ...snapshot,
                    rows: snapshot.rows.map((row) => ({
                        ...row,
                        value: project[subset.objectType]!(row.value),
                    })),
                };
            }),
        invoke: (invocation) =>
            call(
                ir.actionTypes.some((action) => action.name === invocation.name),
                backend.invoke(invocation)
            ),
        queryFunction: (name, parameters) =>
            call(
                ir.queryFunctionTypes.some((query) => query.name === name),
                backend.queryFunction(name, parameters)
            ),
        changes: backend.changes && {
            pull: (request) =>
                Effect.map(backend.changes!.pull(request), (page) => ({
                    ...page,
                    commits: page.commits.map((commit) => ({
                        ...commit,
                        changes: commit.changes
                            .filter((change) => Object.hasOwn(project, change.objectType))
                            .map((change) =>
                                change.kind === "put"
                                    ? { ...change, value: project[change.objectType]!(change.value) }
                                    : change
                            ),
                    })),
                })),
            watch: backend.changes.watch,
        },
        attachments: backend.attachments,
        encrypted: backend.encrypted,
    };
}
const isField = Schema.is(
    Schema.Struct({ _tag: Schema.Literal("Field"), path: Schema.Array(Schema.String) })
);
