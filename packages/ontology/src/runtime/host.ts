import { makeReplicaHost as openHost } from "@party-stack/ontology-replica/host";
import { Effect, Fiber } from "effect";
import { createLiveOntologyAttachments } from "../live/attachments/createLiveOntologyAttachments.js";
import { blobManagerClient } from "./blobs/createBlobManager.js";
import { observeReplicaRows } from "./hostQuery.js";
import { actionMutators } from "./transactions.js";
import type { LiveOntology, LiveOntologyWrites } from "../live/LiveOntology.js";
import type { OntologyBackendAdapter } from "../live/OntologyBackendAdapter.js";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { BackendError, BackendSubset, OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaOptions, ReplicaService } from "@party-stack/ontology-replica";
import type { BlobManagerService } from "@party-stack/ontology-replica/attachments";
import type { AttachmentTypeDef, OntologyIR } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { Row } from "@party-stack/ontology-storage";
import type { ByteInput } from "@party-stack/ontology-storage/blobs";
import type { Runtime } from "@party-stack/runtime";
import type { Scope, Stream } from "effect";
interface ReplicaHostCommonOptions {
    readonly id?: string;
    readonly ir: OntologyIR;
    readonly context: Record<string, unknown>;
    readonly writes?: LiveOntologyWrites;
    readonly connection?: ConnectionMonitor;
    readonly objectCacheGc?: ReplicaOptions["objectCacheGc"];
    readonly demand?: ReplicaOptions["demand"];
    readonly clients?: ReplicaOptions["clients"];
}
/** A native connection can additionally publish speculative parent state. */
export type ReplicaHostOptions = ReplicaHostCommonOptions &
    (
        | {
              readonly backendAdapter: OntologyBackendAdapter;
              readonly backend?: never;
              readonly source?: never;
          }
        | {
              readonly backend: OntologyBackendService;
              readonly source?: OntologySource;
              readonly backendAdapter?: never;
          }
    );
export interface ReplicaHostService {
    readonly replica: ReplicaService;
    readonly backend: OntologyBackendService;
    readonly blobManager: BlobManagerService;
    readonly attachments: LiveOntology["attachments"];
    readonly stageAttachment?: (
        value: attachment,
        bytes: ByteInput,
        target?: AttachmentTypeDef
    ) => Promise<attachment>;
    readonly observe: (
        subset: BackendSubset,
        options?: { readonly persistedOnly?: boolean }
    ) => Stream.Stream<readonly Row<Record<string, unknown>>[], BackendError>;
}

/** Application facade: adapt authoring types and SDK promises around the native scoped host. */
export const makeReplicaHost = Effect.fn("OntologyHost.open")(function* (
    options: ReplicaHostOptions
): Effect.fn.Return<ReplicaHostService, BackendError, Runtime | Scope.Scope> {
    const backend = options.backend ?? (yield* options.backendAdapter!.open(options.context));
    const native = yield* openHost({
        id: options.id,
        ir: options.ir,
        context: options.context,
        backend,
        source: options.source,
        mutators: actionMutators(options.ir, options.writes?.mutators),
        outbox: options.writes?.outbox,
        connection: options.connection,
        objectCacheGc: options.objectCacheGc,
        demand: options.demand,
        clients: options.clients,
    });
    const captured = yield* Effect.context<never>();
    const scope = yield* Effect.scope;
    const run = <A>(effect: Effect.Effect<A, BackendError>, signal?: AbortSignal) =>
        Effect.runPromiseWith(captured)(
            Effect.flatMap(Effect.forkIn(effect, scope), (fiber) =>
                Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
            ),
            { signal }
        );
    const stageAttachment = native.stageAttachment
        ? (value: attachment, bytes: ByteInput, target?: AttachmentTypeDef) =>
              run(native.stageAttachment!(value, bytes, target))
        : undefined;
    return {
        ...native,
        stageAttachment,
        attachments: createLiveOntologyAttachments({
            ir: options.ir,
            blobManager: blobManagerClient(native.blobManager, run),
            stageAttachment,
        }),
        observe: (subset, settings) => observeReplicaRows(native.replica, subset, settings),
    };
});
