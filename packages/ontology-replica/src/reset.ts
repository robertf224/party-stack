import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { makeBlobStorage, type BlobStorageService } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Transaction } from "@party-stack/ontology-storage/tables";
import type { RuntimeService } from "@party-stack/runtime";

export const assertReplicaRebuildSafe = Effect.fnUntraced(function* (
    runtime: RuntimeService,
    namespace: string,
    sourceId: string
) {
    const name = (part: string) => JSON.stringify(["replica", namespace, part]);
    yield* runtime.tables
        .read((tx) =>
            Effect.gen(function* () {
                const stored = yield* tx.get(
                    Table.make<{ source: string }>({ name: name("position") }),
                    "head"
                );
                if (stored && stored.source !== sourceId)
                    return yield* new BackendError({
                        operation: "replica.rebuild",
                        kind: "SourceMismatch",
                        retryable: false,
                        message: "A replica rebuild cannot change its upstream source.",
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
                if (stored?.signature === signature) return;
                const next = yield* resetReplicaHead(
                    tx,
                    {
                        namespace,
                        blobs,
                        previousObjectTypes: options.previous.objectTypes.map((type) => type.name),
                        ir: options.ir,
                        signature,
                    },
                    stored
                );
                if (next) yield* tx.put(position, "head", next);
            })
        )
        .pipe(Effect.mapError((cause) => classifyBackendFailure("replica.rebuild", cause)));
});

/**
 * Clear a replica's cached data for a new definition inside the caller's transaction, and
 * return the position row to store (undefined when there was none). Keeps the outbox, session
 * ledgers, imported parent actions (replaced by the next snapshot) and every named pin's desired
 * query, so pinned downloads are fetched again. Queued actions are not touched: the replica's
 * startup rebase replays their predictions against the new definition, and one that no longer
 * applies keeps going with its prediction dropped. The caller has checked the source and owns
 * the position row in this transaction.
 */
export const resetReplicaHead = <Stored extends object>(
    tx: Transaction,
    options: {
        readonly namespace: string;
        readonly blobs?: BlobStorageService;
        /** Object types of the definition being replaced; their tables are cleared too. */
        readonly previousObjectTypes: Iterable<string>;
        readonly ir: OntologyIR;
        readonly signature: string;
    },
    stored: Stored | undefined
) =>
    Effect.gen(function* () {
        const { namespace, blobs } = options;
        const name = (part: string) => JSON.stringify(["replica", namespace, part]);
        const types = new Set([
            ...options.previousObjectTypes,
            ...options.ir.objectTypes.map((type) => type.name),
        ]);
        for (const type of types) {
            for (const layer of ["base", "parent-base", "parent-overlay", "overlay"])
                yield* tx.clear(Table.make({ name: name(`${layer}:${type}`) }));
            for (const layer of ["base", "overlay"])
                if (blobs)
                    yield* blobs.in(tx).releaseGroup(JSON.stringify(["replica-row", namespace, layer, type]));
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
        // Each named pin has its own member table and byte owners. Clear them and keep only the
        // desired query (with its generation), so every pin installs again against the new data.
        const pins = Table.make<{ desired: unknown; removed?: boolean }>({ name: name("query-pin") });
        for (const { key, value } of yield* tx.query(pins)) {
            const id = String(key);
            yield* tx.clear(Table.make({ name: JSON.stringify(["replica", namespace, "pin-members", id]) }));
            if (value.removed) yield* tx.delete(pins, id);
            else yield* tx.put(pins, id, { desired: value.desired });
            if (blobs && id !== "head") {
                yield* blobs.in(tx).release(name(`query-pin-bytes:${id}`));
                yield* blobs.in(tx).release(name(`query-pin-pending-bytes:${id}`));
            }
        }
        if (blobs) {
            yield* blobs.in(tx).release(name("query-pin-bytes"));
            yield* blobs.in(tx).release(name("query-pin-pending-bytes"));
        }
        return stored
            ? {
                  ...stored,
                  signature: options.signature,
                  cursor: undefined,
                  parentViewIdentity: undefined,
                  deliverySelection: undefined,
                  deliveryMembershipVersion: undefined,
                  deliveryResident: false,
              }
            : undefined;
    });
