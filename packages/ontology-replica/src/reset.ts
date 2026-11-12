import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { definitionTable, signatureStamp } from "./definitionStamp.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { RuntimeService } from "@party-stack/runtime";

export const assertReplicaRebuildSafe = Effect.fnUntraced(function* (
    runtime: RuntimeService,
    namespace: string,
    sourceId: string,
    signature: string
) {
    const name = (part: string) => JSON.stringify(["replica", namespace, part]);
    const stamp = yield* signatureStamp(signature).pipe(
        Effect.mapError((cause) => classifyBackendFailure("replica.rebuild.definition", cause))
    );
    yield* runtime.tables
        .read((tx) =>
            Effect.gen(function* () {
                const stored = yield* tx.get(
                    Table.make<{ source: string; signature: string }>({ name: name("position") }),
                    "head"
                );
                if (stored && stored.source !== sourceId)
                    return yield* new BackendError({
                        operation: "replica.rebuild",
                        kind: "SourceMismatch",
                        retryable: false,
                        message: "A replica rebuild cannot change its upstream source.",
                    });
                if (stored?.signature === signature || stored?.signature === stamp) return;
                for (const part of ["outbox", "parent-pending"])
                    if ((yield* tx.query(Table.make({ name: name(part) }), { limit: 1 })).length > 0)
                        return yield* new BackendError({
                            operation: "replica.rebuild",
                            kind: "Conflict",
                            retryable: false,
                            message: "The replica has pending actions; its cache cannot be rebuilt safely.",
                        });
            })
        )
        .pipe(Effect.mapError((cause) => classifyBackendFailure("replica.rebuild", cause)));
});

/** Reset disposable data, never the action/session ledgers or device keys.
 * The new definition stamp is committed in the same transaction, making a
 * persisted catalog rebuild intent idempotent after a process interruption.
 */
export const resetReplicaCache = Effect.fn("Replica.resetCache")(function* (options: {
    runtime: RuntimeService;
    namespace: string;
    previous: OntologyIR;
    ir: OntologyIR;
    sourceId: string;
}) {
    const { runtime, namespace } = options;
    const name = (part: string) => JSON.stringify(["replica", namespace, part]);
    const position = Table.make<Record<string, unknown> & { signature: string; source: string }>({
        name: name("position"),
    });
    const signature = yield* Effect.try({
        try: () => ontologyDefinitionSignature(options.ir),
        catch: (cause) => classifyBackendFailure("replica.rebuild.definition", cause),
    });
    const stamp = yield* signatureStamp(signature).pipe(
        Effect.mapError((cause) => classifyBackendFailure("replica.rebuild.definition", cause))
    );
    const blobs = yield* makeBlobStorage({
        tables: runtime.tables,
        bytes: runtime.bytes,
        namespace: JSON.stringify([runtime.owner, runtime.namespace]),
    }).pipe(Effect.mapError((cause) => classifyBackendFailure("replica.rebuild.blobs", cause)));
    yield* runtime.tables
        .transaction((tx) =>
            Effect.gen(function* () {
                const stored = yield* tx.get(position, "head", { forUpdate: true });
                if (stored && stored.source !== options.sourceId)
                    return yield* new BackendError({
                        operation: "replica.rebuild",
                        kind: "SourceMismatch",
                        retryable: false,
                        message: "A replica rebuild cannot change its upstream source.",
                    });
                // A crash may leave the catalog marker after this transaction committed.
                // Never repeat the reset, including when a new action now exists.
                if (stored?.signature === signature || stored?.signature === stamp) return;
                for (const part of ["outbox", "parent-pending"])
                    if ((yield* tx.query(Table.make({ name: name(part) }), { limit: 1 })).length > 0)
                        return yield* new BackendError({
                            operation: "replica.rebuild",
                            kind: "Conflict",
                            retryable: false,
                            message: "The replica has pending actions; its cache cannot be rebuilt safely.",
                        });
                const types = new Set(
                    [...options.previous.objectTypes, ...options.ir.objectTypes].map((type) => type.name)
                );
                for (const type of types) {
                    for (const layer of ["base", "parent-base", "parent-overlay", "overlay"])
                        yield* tx.clear(Table.make({ name: name(`${layer}:${type}`) }));
                    for (const layer of ["base", "overlay"])
                        yield* blobs
                            .in(tx)
                            .releaseGroup(JSON.stringify(["replica-row", namespace, layer, type]));
                }
                for (const part of [
                    "coverage",
                    "retention",
                    "roots",
                    "action-rows",
                    "action-queries",
                    "pins",
                    "sweep",
                    "delivery-seen",
                    "parent-head",
                ])
                    yield* tx.clear(Table.make({ name: name(part) }));
                for (const part of ["state", "changes", "frames"])
                    yield* tx.clear(
                        Table.make({ name: JSON.stringify([name("upstream"), "incoming-delivery", part]) })
                    );
                const pin = Table.make<{ desired: unknown }>({ name: name("query-pin") });
                const desired = yield* tx.get(pin, "head");
                if (desired) yield* tx.put(pin, "head", { desired: desired.desired });
                yield* blobs.in(tx).release(name("query-pin-bytes"));
                yield* blobs.in(tx).release(name("query-pin-pending-bytes"));
                if (stored) {
                    yield* tx.put(definitionTable(name), "current", { signature });
                    yield* tx.put(position, "head", {
                        ...stored,
                        signature: stamp,
                        cursor: undefined,
                        parentViewIdentity: undefined,
                        deliverySelection: undefined,
                        deliveryMembershipVersion: undefined,
                        deliveryResident: false,
                    });
                }
            })
        )
        .pipe(Effect.mapError((cause) => classifyBackendFailure("replica.rebuild", cause)));
});
