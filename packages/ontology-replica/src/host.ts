import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeBlobStorage, exclusiveOwnerLiveness } from "@party-stack/ontology-storage/blobs";
import { Runtime } from "@party-stack/runtime";
import { Effect } from "effect";
import { makeReplica } from "./service.js";
import type { ReplicaOptions } from "./service.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

export interface ReplicaHostOptions extends Omit<
    ReplicaOptions,
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
> {
    readonly id?: string;
    readonly backend: OntologyBackendService;
    readonly source?: OntologySource;
}
/** Platform composition only. Native operations and their lifecycle belong to Replica. */
export const makeReplicaHost = Effect.fn("ReplicaHost.open")(function* (options: ReplicaHostOptions) {
    const runtime = yield* Runtime;
    const blobs = yield* makeBlobStorage({
        namespace: JSON.stringify([runtime.owner, runtime.namespace]),
        tables: runtime.tables,
        bytes: runtime.bytes,
        ...exclusiveOwnerLiveness(runtime.tables),
    }).pipe(Effect.mapError((cause) => classifyBackendFailure("attachment.storage", cause)));
    const replica = yield* makeReplica({
        ...options,
        namespace: options.id ?? runtime.namespace,
        tables: runtime.tables,
        blobs,
        network: runtime.connectivity,
        capacity: runtime.capacity,
        encrypted: options.backend.encrypted,
        encryptionKeyring: runtime.encryptionKeyring,
        clientSessions: options.clientSessions ?? { sessionIdleTimeoutMs: 10 * 60_000 },
    });
    return { replica, backend: options.backend };
});
