import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import {
    ontologyDefinitionContractSignature,
    ontologyDefinitionSignature,
} from "@party-stack/ontology-storage";
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

/** Empty a cached table and drop its indexes: they were built for the old definition (for
 * example on a primary key that moved), and the replica ensures them again when it opens. */
const clearTable = (tx: Transaction, tableName: string) =>
    Effect.gen(function* () {
        const table = Table.make({ name: tableName });
        yield* tx.clear(table);
        for (const index of yield* tx.indexes(table)) yield* tx.dropIndex(table, index.name);
    });

/** Which cached data a definition change invalidates. */
export type DefinitionResetPlan =
    | { readonly kind: "none" }
    | { readonly kind: "types"; readonly types: ReadonlySet<string> }
    | { readonly kind: "all" };

const emptyDefinition: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};
const isDefinition = (value: unknown): value is OntologyIR =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { objectTypes?: unknown }).objectTypes) &&
    Array.isArray((value as { types?: unknown }).types ?? []);

/**
 * Compare a stored definition with a new one object type by object type. Only rows are cached
 * per type, so a type's rows survive unless its own contract (properties, primary key,
 * constraints) changed or it was removed. Actions, links and query functions hold no cached
 * rows. Named value types, context and policy are shared by every type (policy decides which
 * rows a reader may see), so a change to them invalidates everything, as does a stored
 * definition that can no longer be read.
 */
export function planDefinitionReset(previous: unknown, next: OntologyIR): DefinitionResetPlan {
    if (!isDefinition(previous)) return { kind: "all" };
    try {
        const shared = (ir: OntologyIR) =>
            ontologyDefinitionContractSignature({
                ...emptyDefinition,
                types: ir.types ?? [],
                ...(ir.context ? { context: ir.context } : {}),
                ...(ir.policy ? { policy: ir.policy } : {}),
            });
        if (shared(previous) !== shared(next)) return { kind: "all" };
        const typeSignature = (ir: OntologyIR, name: string) => {
            const type = ir.objectTypes.find((candidate) => candidate.name === name);
            return (
                type &&
                ontologyDefinitionContractSignature({
                    ...emptyDefinition,
                    types: ir.types ?? [],
                    objectTypes: [type],
                })
            );
        };
        const types = new Set(
            previous.objectTypes
                .map((type) => type.name)
                .filter((name) => typeSignature(previous, name) !== typeSignature(next, name))
        );
        return types.size ? { kind: "types", types } : { kind: "none" };
    } catch {
        return { kind: "all" };
    }
}

/**
 * Clear only the given object types' cached rows and the bookkeeping that refers to them, inside
 * the caller's transaction: their base, overlay and attachment roots, coverage, retention,
 * action read sets and download membership. Other types keep their rows and coverage, and the
 * sync position is kept. A download that held rows of a cleared type is marked not installed,
 * keeping its desired query, so it reinstalls.
 */
export const resetObjectTypes = (
    tx: Transaction,
    options: {
        readonly namespace: string;
        readonly blobs?: BlobStorageService;
        readonly types: ReadonlySet<string>;
    }
) =>
    Effect.gen(function* () {
        const { namespace, blobs, types } = options;
        const name = (part: string) => JSON.stringify(["replica", namespace, part]);
        for (const type of types) {
            for (const layer of ["base", "parent-base", "parent-overlay", "overlay"])
                yield* clearTable(tx, name(`${layer}:${type}`));
            for (const layer of ["base", "overlay"])
                if (blobs)
                    yield* blobs.in(tx).releaseGroup(JSON.stringify(["replica-row", namespace, layer, type]));
        }
        const removeWhere = (part: string, objectType: (value: Record<string, unknown>) => unknown) =>
            Effect.gen(function* () {
                const table = Table.make<Record<string, unknown>>({ name: part });
                for (const row of yield* tx.query(table))
                    if (types.has(String(objectType(row.value)))) yield* tx.delete(table, row.key);
            });
        const subsetType = (value: Record<string, unknown>) =>
            (value.subset as { objectType?: unknown } | undefined)?.objectType;
        yield* removeWhere(name("coverage"), subsetType);
        yield* removeWhere(name("action-queries"), subsetType);
        for (const part of ["retention", "action-rows", "pins"])
            yield* removeWhere(name(part), (value) => value.objectType);
        yield* tx.clear(Table.make({ name: name("sweep") }));
        const pins = Table.make<{ desired: unknown; removed?: boolean }>({ name: name("query-pin") });
        for (const { key, value } of yield* tx.query(pins)) {
            const id = String(key);
            const members = Table.make<{ objectType: string }>({
                name: JSON.stringify(["replica", namespace, "pin-members", id]),
            });
            let touched = false;
            for (const member of yield* tx.query(members))
                if (types.has(member.value.objectType)) {
                    touched = true;
                    yield* tx.delete(members, member.key);
                }
            if (touched && !value.removed) yield* tx.put(pins, id, { desired: value.desired });
        }
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
                yield* clearTable(tx, name(`${layer}:${type}`));
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
