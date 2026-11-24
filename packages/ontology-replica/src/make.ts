import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { Runtime } from "@party-stack/runtime";
import { Effect } from "effect";
import { followReplicaDefinition } from "./follow.js";
import { makeReplica as makeReplicaFromStorage } from "./service.js";
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
> & {
    readonly id?: string;
    readonly source?: OntologySource;
};
/** Builds the backend for one definition, for providers whose adapter compiles the IR. */
export type ReplicaBackendFactory = (
    ir: OntologyIR
) => Effect.Effect<OntologyBackendService, BackendError, Scope.Scope>;

export type ReplicaOptions = Common &
    (
        | {
              /** A fixed definition. */
              readonly ir: OntologyIR;
              readonly definition?: never;
              readonly backend: OntologyBackendService;
          }
        | {
              /**
               * A definition to follow. The replica opens under the first one and reopens behind
               * the same handle under each later one whose contract differs, clearing what
               * `onDefinitionChange` requires. Live queries, demand and the outbox carry over.
               */
              readonly definition: ReplicaDefinition;
              readonly ir?: never;
              readonly backend: OntologyBackendService | ReplicaBackendFactory;
          }
    );

/** Platform composition only. Native operations and their lifecycle belong to Replica. */
export const makeReplica = Effect.fn("Replica.open")(function* (options: ReplicaOptions) {
    const runtime = yield* Runtime;
    const blobs = yield* makeBlobStorage({
        namespace: JSON.stringify([runtime.owner, runtime.namespace]),
        tables: runtime.tables,
        bytes: runtime.bytes,
        ...exclusiveOwnerLiveness(runtime.tables),
    }).pipe(Effect.mapError((cause) => classifyBackendFailure("attachment.storage", cause)));
    const open = (ir: OntologyIR, backend: OntologyBackendService) =>
        makeReplicaFromStorage({
            ...options,
            ir,
            backend,
            namespace: options.id ?? runtime.namespace,
            tables: runtime.tables,
            blobs,
            network: runtime.connectivity,
            capacity: runtime.capacity,
            encrypted: backend.encrypted,
            encryptionKeyring: runtime.encryptionKeyring,
            clientSessions: options.clientSessions ?? { sessionIdleTimeoutMs: 10 * 60_000 },
        });
    if (!options.definition) return yield* open(options.ir, options.backend);
    const { backend } = options;
    return yield* followReplicaDefinition({
        definition: options.definition,
        open: (ir) =>
            typeof backend === "function"
                ? Effect.flatMap(backend(ir), (built) => open(ir, built))
                : open(ir, backend),
    });
});
