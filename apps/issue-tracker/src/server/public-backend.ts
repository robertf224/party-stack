import { applyLensToObject, o } from "@party-stack/ontology";
import {
    makeOntologyBackend,
    BackendError,
    type OntologyBackendService,
} from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { Effect } from "effect";
import type { OntologyIR } from "@party-stack/ontology";

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
            kind: "Forbidden",
            message: "Operation is outside the public ontology view.",
            retryable: false,
        });
    const call = <A>(allowed: boolean, effect: Effect.Effect<A, BackendError>) =>
        allowed ? effect : Effect.fail(rejected());
    return makeOntologyBackend({
        ir,
        name: backend.name,
        sourceId: backend.sourceId,
        supportsIdempotency: backend.supportsIdempotency,
        loadSubset: (request) =>
            Effect.gen(function* () {
                const subset = yield* compileObjectSubset(ir, request).pipe(Effect.mapError(rejected));
                const snapshot = yield* backend.loadSubset(request);
                return {
                    ...snapshot,
                    rows: snapshot.rows.map((row) => ({
                        ...row,
                        value: project[subset.objectType]!(row.value),
                    })),
                };
            }),
        applyAction: (invocation) =>
            call(
                ir.actionTypes.some((action) => action.name === invocation.name),
                backend.applyAction(invocation)
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
    });
}
