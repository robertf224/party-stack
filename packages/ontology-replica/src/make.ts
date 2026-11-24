import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { Runtime } from "@party-stack/runtime";
import { Effect } from "effect";
import { makeReplicaDeliveries } from "./engine.js";
import { followReplicaDefinition, revalidateOnMismatch } from "./follow.js";
import { planDefinitionReset } from "./reset.js";
import { isReplicaDefinition, makeReplica as makeReplicaFromStorage } from "./service.js";
import type { ReplicaDeliveries } from "./engine.js";
import type { ReplicaDefinition, ReplicaOptions as StorageReplicaOptions } from "./service.js";
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

export type ReplicaOptions = Common &
    (
        | {
              /**
               * The definition: a fixed `OntologyIR`, or a source the replica follows. A followed
               * replica opens under the first definition and reopens behind the same handle under
               * each later one that differs, clearing what `onDefinitionChange` requires. Live
               * queries, demand and the outbox carry over.
               */
              readonly definition: OntologyIR | ReplicaDefinition;
              readonly ir?: never;
              /** A backend, or one built for each definition. */
              readonly backend: OntologyBackendService | ReplicaBackendFactory;
          }
        | {
              /** @deprecated Use `definition`. */
              readonly ir: OntologyIR;
              readonly definition?: never;
              readonly backend: OntologyBackendService;
          }
    );

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
    const source = options.definition ?? options.ir;
    const { backend } = options;
    if (!isReplicaDefinition(source)) return yield* open(source, yield* connect(backend, source));
    const definition = source;
    // Children's delivery state outlives each engine, so a child resumes after a reopen and
    // receives only the object types whose rows changed shape.
    const deliveries = yield* makeReplicaDeliveries({
        tables: runtime.tables,
        namespace: options.id ?? runtime.namespace,
    });
    const watched = ({ backend, source }: ReplicaConnection): ReplicaConnection => ({
        backend: definition.revalidate ? revalidateOnMismatch(backend, definition.revalidate) : backend,
        source,
    });
    return yield* followReplicaDefinition({
        definition,
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
