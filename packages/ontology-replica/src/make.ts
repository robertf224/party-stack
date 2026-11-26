import { classifyBackendFailure } from "@party-stack/ontology-backend";
import metaOntology from "@party-stack/ontology-spec/meta";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { Runtime } from "@party-stack/runtime";
import { Effect, Stream } from "effect";
import { makeReplicaDeliveries } from "./engine.js";
import { followReplicaDefinition, revalidateOnMismatch } from "./follow.js";
import { definitionHints } from "./internal.js";
import { followMetaReplica } from "./metaDefinition.js";
import { planDefinitionReset } from "./reset.js";
import { makeReplica as makeReplicaFromStorage } from "./service.js";
import type { ReplicaDeliveries } from "./engine.js";
import type {
    FollowedReplicaDefinition,
    ReplicaDefinition,
    ReplicaOptions as StorageReplicaOptions,
} from "./service.js";
import type { BackendError, OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Scope } from "effect";

type Common = Omit<
    StorageReplicaOptions,
    | "ir"
    | "namespace"
    | "tables"
    | "blobs"
    | "network"
    | "capacity"
    | "backend"
    | "source"
    | "attachments"
    | "encrypted"
    | "encryptionKeyring"
    | "deliveries"
> & {
    readonly id?: string;
    readonly source?: OntologySource;
};
/** A backend together with the protocol source that feeds it, for a replica fed by another server. */
export interface ReplicaConnection {
    readonly backend: OntologyBackendService;
    readonly source?: OntologySource;
}
/** Builds the backend for one definition, for providers whose adapter compiles the IR. */
export type ReplicaBackendFactory = (
    ir: OntologyIR
) => Effect.Effect<OntologyBackendService | ReplicaConnection, BackendError, Scope.Scope>;

export type ReplicaOptions = Common & {
    /**
     * The definition. `{ kind: "static", ir }` opens under a fixed `OntologyIR`.
     * `{ kind: "dynamic", meta, select? }` reads it from a metadata backend: the replica keeps a
     * replica of the metadata it reads in the same storage, opens under the definition it
     * describes, and reopens behind the same handle when it changes, clearing what
     * `onDefinitionChange` requires. Live queries, demand and the outbox carry over.
     */
    readonly definition: ReplicaDefinition | FollowedReplicaDefinition;
    /** @internal The definition this replica last had open, for a dynamic replica to open under
     * before its metadata is read (offline, or before the metadata replica has any rows). */
    readonly retained?: OntologyIR;
    /** A backend, or one built for each definition. */
    readonly backend: OntologyBackendService | ReplicaBackendFactory;
};

const connect = (
    backend: OntologyBackendService | ReplicaBackendFactory,
    ir: OntologyIR
): Effect.Effect<ReplicaConnection, BackendError, Scope.Scope> =>
    typeof backend === "function"
        ? Effect.map(backend(ir), (built) => ("loadSubset" in built ? { backend: built } : built))
        : Effect.succeed({ backend });

/** Platform composition only. Native operations and their lifecycle belong to Replica. */
export const makeReplica = Effect.fn("Replica.open")(function* (options: ReplicaOptions) {
    const runtime = yield* Runtime;
    const blobs = yield* makeBlobStorage({
        namespace: JSON.stringify([runtime.owner, runtime.namespace]),
        tables: runtime.tables,
        bytes: runtime.bytes,
        ...exclusiveOwnerLiveness(runtime.tables),
    }).pipe(Effect.mapError((cause) => classifyBackendFailure("attachment.storage", cause)));
    const open = (ir: OntologyIR, connection: ReplicaConnection, deliveries?: ReplicaDeliveries) =>
        makeReplicaFromStorage({
            ...options,
            ir,
            backend: connection.backend,
            source: connection.source ?? options.source,
            deliveries,
            namespace: options.id ?? runtime.namespace,
            tables: runtime.tables,
            blobs,
            network: runtime.connectivity,
            capacity: runtime.capacity,
            encrypted: connection.backend.encrypted,
            encryptionKeyring: runtime.encryptionKeyring,
            clientSessions: options.clientSessions ?? { sessionIdleTimeoutMs: 10 * 60_000 },
        });
    const { backend, definition } = options;
    if (definition.kind === "static")
        return yield* open(definition.ir, yield* connect(backend, definition.ir));
    const namespace = options.id ?? runtime.namespace;
    const followed =
        definition.kind === "followed"
            ? definition
            : yield* followMetaReplica(
                  // Metadata the definition is read from, kept beside the data it describes.
                  yield* makeReplicaFromStorage({
                      ir: metaOntology,
                      backend: definition.meta,
                      namespace: JSON.stringify([namespace, "meta"]),
                      live: options.live,
                      authentication: options.authentication,
                      onDefinitionChange: "reset",
                      tables: runtime.tables,
                      network: runtime.connectivity,
                      capacity: runtime.capacity,
                  }),
                  definition.select,
                  (definition as { readonly [definitionHints]?: Stream.Stream<unknown> })[definitionHints]
              );
    let primed = !options.retained;
    const source: FollowedReplicaDefinition = {
        ...followed,
        // Once only: the follower subscribes again after a source failure.
        changes: Stream.suspend(() => {
            if (primed) return followed.changes;
            primed = true;
            return Stream.concat(Stream.make(options.retained!), followed.changes);
        }),
    };
    // Children's delivery state outlives each engine, so a child resumes after a reopen and
    // receives only the object types whose rows changed shape.
    const deliveries = yield* makeReplicaDeliveries({ tables: runtime.tables, namespace });
    const watched = ({ backend, source: protocol }: ReplicaConnection): ReplicaConnection => ({
        backend: source.revalidate ? revalidateOnMismatch(backend, source.revalidate) : backend,
        source: protocol,
    });
    return yield* followReplicaDefinition({
        definition: source,
        open: (ir) =>
            Effect.flatMap(connect(backend, ir), (connection) => open(ir, watched(connection), deliveries)),
        changed: (previous, next) => {
            const plan = planDefinitionReset(previous, next);
            const types = plan.kind === "all" ? "all" : plan.kind === "types" ? plan.types : undefined;
            return types
                ? Effect.andThen(
                      deliveries.committed.invalidate(types),
                      deliveries.speculative.invalidate(types)
                  )
                : Effect.void;
        },
    });
});
