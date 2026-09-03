import {
    isCoordinationHost,
    type Coordination,
    type CoordinationServiceClient,
    type CoordinationServiceServer,
} from "@party-stack/coordination";
import { safeRandomUUID } from "@tanstack/db-sqlite-persistence-core";
import type { LoadSubsetOptions } from "@tanstack/db";
import type {
    ApplyLocalMutationsResponse,
    PersistedCollectionCoordinator,
    PersistedIndexSpec,
    PersistedMutationEnvelope,
    PersistenceAdapter,
    ProtocolEnvelope,
    PullSinceResponse,
    ReplayableTxDelta,
} from "@tanstack/db-sqlite-persistence-core";

const PERSISTENCE_SERVICE =
    "party-stack.persistence.v1";
const MAX_DEDUPLICATION_ENTRIES = 1_000;
const MAX_PENDING_RELAYS = 1_000;

interface CollectionPosition {
    term: number;
    seq: number;
    rowVersion: number;
}

interface EnsureLeadershipInput {
    collectionId: string;
}

interface EnsureRemoteSubsetInput {
    collectionId: string;
    options: LoadSubsetOptions;
}

interface EnsurePersistedIndexInput {
    collectionId: string;
    signature: string;
    spec: PersistedIndexSpec;
}

interface ApplyLocalMutationsInput {
    collectionId: string;
    rpcId: string;
    envelopeId: string;
    mutations: PersistedMutationEnvelope[];
}

interface PullSinceInput {
    collectionId: string;
    rpcId: string;
    fromRowVersion: number;
}

interface RelayMessageInput {
    collectionId: string;
    message: ProtocolEnvelope<unknown>;
}

interface PersistenceCoordinationService {
    methods: {
        ensureLeadership(
            input: EnsureLeadershipInput
        ): Promise<void>;
        ensureRemoteSubset(
            input: EnsureRemoteSubsetInput
        ): Promise<void>;
        ensurePersistedIndex(
            input: EnsurePersistedIndexInput
        ): Promise<void>;
        applyLocalMutations(
            input: ApplyLocalMutationsInput
        ): Promise<ApplyLocalMutationsResponse>;
        pullSince(
            input: PullSinceInput
        ): Promise<PullSinceResponse>;
        relayMessage(
            input: RelayMessageInput
        ): Promise<void>;
    };
    events: {
        message: RelayMessageInput;
    };
}

type AdapterWithPullSince = PersistenceAdapter & {
    pullSince?: (
        collectionId: string,
        fromRowVersion: number
    ) => Promise<
        | {
              latestRowVersion: number;
              requiresFullReload: true;
          }
        | {
              latestRowVersion: number;
              requiresFullReload: false;
              changedKeys: Array<
                  string | number
              >;
              deletedKeys: Array<
                  string | number
              >;
              deltas?: Array<
                  ReplayableTxDelta<
                      Record<string, unknown>,
                      string | number
                  >
              >;
          }
    >;
};

const coordinatorCache = new WeakMap<
    Coordination,
    WeakMap<
        PersistenceAdapter,
        PersistedCollectionCoordinator
    >
>();

function isRecord(
    value: unknown
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null
    );
}

function relayKey(
    collectionId: string,
    message: ProtocolEnvelope<unknown>
): string {
    const payload = isRecord(message.payload)
        ? message.payload
        : {};
    return JSON.stringify([
        collectionId,
        message.senderId,
        payload.type,
        payload.txId,
        payload.resetEpoch,
        payload.term,
        payload.seq,
    ]);
}

export function createPersistedCollectionCoordinator(
    coordination: Coordination,
    adapter: PersistenceAdapter
): PersistedCollectionCoordinator {
    let adapters =
        coordinatorCache.get(coordination);
    if (!adapters) {
        adapters = new WeakMap();
        coordinatorCache.set(coordination, adapters);
    }
    const existing = adapters.get(adapter);
    if (existing) return existing;

    const created = new CoordinationPersistenceShim(
        coordination,
        adapter as AdapterWithPullSince
    );
    adapters.set(adapter, created);
    return created;
}

class CoordinationPersistenceShim
    implements PersistedCollectionCoordinator
{
    private readonly nodeId = safeRandomUUID();
    private readonly positions = new Map<
        string,
        Promise<CollectionPosition>
    >();
    private readonly appliedEnvelopes = new Map<
        string,
        Extract<
            ApplyLocalMutationsResponse,
            { ok: true }
        >
    >();
    private readonly relayedMessages = new Set<string>();
    private readonly service: CoordinationServiceClient<PersistenceCoordinationService>;
    private readonly server:
        | CoordinationServiceServer<PersistenceCoordinationService>
        | undefined;
    private pendingRelays = 0;

    constructor(
        private readonly coordination: Coordination,
        private readonly adapter: AdapterWithPullSince
    ) {
        this.service =
            coordination.service<PersistenceCoordinationService>(
                PERSISTENCE_SERVICE
            );
        this.server = isCoordinationHost(
            coordination
        )
            ? coordination.serve<PersistenceCoordinationService>(
                  PERSISTENCE_SERVICE,
                  {
                      ensureLeadership: () =>
                          Promise.resolve(),
                      ensureRemoteSubset: () =>
                          Promise.resolve(),
                      ensurePersistedIndex: (
                          input
                      ) =>
                          this.adapter.ensureIndex(
                              input.collectionId,
                              input.signature,
                              input.spec
                          ),
                      applyLocalMutations: (
                          input
                      ) =>
                          this.applyMutations(
                              input
                          ),
                      pullSince: (input) =>
                          this.handlePullSince(
                              input
                          ),
                      relayMessage: (input) =>
                          this.relayMessage(input),
                  }
              )
            : undefined;
    }

    getNodeId(): string {
        return this.nodeId;
    }

    subscribe(
        collectionId: string,
        callback: (
            message: ProtocolEnvelope<unknown>
        ) => void
    ): () => void {
        return this.service.events.subscribe(
            "message",
            (event) => {
                if (
                    event.collectionId ===
                    collectionId
                ) {
                    callback(event.message);
                }
            }
        );
    }

    publish(
        collectionId: string,
        message: ProtocolEnvelope<unknown>
    ): void {
        if (
            this.server &&
            isCoordinationHost(this.coordination) &&
            this.coordination.isLeader
        ) {
            this.publishMessage({
                collectionId,
                message,
            });
            return;
        }
        if (
            this.pendingRelays >=
            MAX_PENDING_RELAYS
        ) {
            console.warn(
                `Dropping persistence relay for "${collectionId}" because the pending relay limit was reached.`
            );
            return;
        }
        this.pendingRelays += 1;
        void this.service.methods
            .relayMessage({
                collectionId,
                message,
            })
            .catch((error: unknown) => {
                console.warn(
                    `Failed to relay persistence message for "${collectionId}".`,
                    error
                );
            })
            .finally(() => {
                this.pendingRelays -= 1;
            });
    }

    isLeader(): boolean {
        return (
            isCoordinationHost(this.coordination) &&
            this.coordination.isLeader
        );
    }

    ensureLeadership(): Promise<void> {
        return this.service.methods.ensureLeadership({
            collectionId: "*",
        });
    }

    requestEnsureRemoteSubset(
        collectionId: string,
        options: LoadSubsetOptions
    ): Promise<void> {
        // TODO(upstream): Move this normalization into
        // @tanstack/db-sqlite-persistence-core so every cross-context
        // coordinator receives transport-safe subset options.
        const serializableOptions = { ...options };
        delete serializableOptions.subscription;
        delete serializableOptions.signal;
        return this.service.methods.ensureRemoteSubset({
            collectionId,
            options: serializableOptions,
        });
    }

    requestEnsurePersistedIndex(
        collectionId: string,
        signature: string,
        spec: PersistedIndexSpec
    ): Promise<void> {
        return this.service.methods.ensurePersistedIndex({
            collectionId,
            signature,
            spec,
        });
    }

    requestApplyLocalMutations(
        collectionId: string,
        mutations: PersistedMutationEnvelope[]
    ): Promise<ApplyLocalMutationsResponse> {
        return this.service.methods.applyLocalMutations({
            collectionId,
            rpcId: safeRandomUUID(),
            envelopeId: safeRandomUUID(),
            mutations,
        });
    }

    pullSince(
        collectionId: string,
        fromRowVersion: number
    ): Promise<PullSinceResponse> {
        return this.service.methods.pullSince({
            collectionId,
            rpcId: safeRandomUUID(),
            fromRowVersion,
        });
    }

    private relayMessage(
        input: RelayMessageInput
    ): Promise<void> {
        const key = relayKey(
            input.collectionId,
            input.message
        );
        if (this.relayedMessages.has(key)) {
            return Promise.resolve();
        }
        this.relayedMessages.add(key);
        if (
            this.relayedMessages.size >
            MAX_DEDUPLICATION_ENTRIES
        ) {
            const oldest =
                this.relayedMessages.values().next()
                    .value;
            if (oldest) {
                this.relayedMessages.delete(oldest);
            }
        }
        this.publishMessage(input);
        return Promise.resolve();
    }

    private publishMessage(
        input: RelayMessageInput
    ): void {
        this.server?.events.publish(
            "message",
            input
        );
    }

    private async position(
        collectionId: string
    ): Promise<CollectionPosition> {
        let position =
            this.positions.get(collectionId);
        if (!position) {
            position = Promise.resolve(
                this.adapter.getStreamPosition?.(
                    collectionId
                )
            ).then((current) => ({
                term:
                    (current?.latestTerm ?? 0) + 1,
                seq: current?.latestSeq ?? 0,
                rowVersion:
                    current?.latestRowVersion ?? 0,
            }));
            this.positions.set(collectionId, position);
        }
        return position;
    }

    private async applyMutations(
        input: ApplyLocalMutationsInput
    ): Promise<ApplyLocalMutationsResponse> {
        const previous =
            this.appliedEnvelopes.get(
                input.envelopeId
            );
        if (previous) {
            return {
                ...previous,
                rpcId: input.rpcId,
            };
        }

        const position = await this.position(
            input.collectionId
        );
        position.seq += 1;
        position.rowVersion += 1;
        const txId = input.envelopeId;
        await this.adapter.applyCommittedTx(
            input.collectionId,
            {
                txId,
                term: position.term,
                seq: position.seq,
                rowVersion: position.rowVersion,
                mutations: input.mutations.map(
                    (mutation) => ({
                        type: mutation.type,
                        key: mutation.key,
                        value: mutation.value,
                    })
                ),
            }
        );
        const committed: ProtocolEnvelope<unknown> = {
            v: 1,
            dbName: this.coordinationScope(),
            collectionId: input.collectionId,
            senderId: this.nodeId,
            ts: Date.now(),
            payload: {
                type: "tx:committed",
                term: position.term,
                seq: position.seq,
                txId,
                latestRowVersion:
                    position.rowVersion,
                requiresFullReload: false,
                changedRows: input.mutations
                    .filter(
                        (mutation) =>
                            mutation.type !==
                            "delete"
                    )
                    .map((mutation) => ({
                        key: mutation.key,
                        value: mutation.value,
                    })),
                deletedKeys: input.mutations
                    .filter(
                        (mutation) =>
                            mutation.type ===
                            "delete"
                    )
                    .map(
                        (mutation) =>
                            mutation.key
                    ),
            },
        };
        this.publishMessage({
            collectionId: input.collectionId,
            message: committed,
        });

        const response: Extract<
            ApplyLocalMutationsResponse,
            { ok: true }
        > = {
            type: "rpc:applyLocalMutations:res",
            rpcId: input.rpcId,
            ok: true,
            term: position.term,
            seq: position.seq,
            latestRowVersion: position.rowVersion,
            acceptedMutationIds: input.mutations.map(
                (mutation) =>
                    mutation.mutationId
            ),
        };
        this.appliedEnvelopes.set(
            input.envelopeId,
            response
        );
        if (
            this.appliedEnvelopes.size >
            MAX_DEDUPLICATION_ENTRIES
        ) {
            const oldest =
                this.appliedEnvelopes.keys().next()
                    .value;
            if (oldest) {
                this.appliedEnvelopes.delete(oldest);
            }
        }
        return response;
    }

    private async handlePullSince(
        input: PullSinceInput
    ): Promise<PullSinceResponse> {
        const position = await this.position(
            input.collectionId
        );
        const result =
            await this.adapter.pullSince?.(
                input.collectionId,
                input.fromRowVersion
            );
        if (!result || result.requiresFullReload) {
            return {
                type: "rpc:pullSince:res",
                rpcId: input.rpcId,
                ok: true,
                latestTerm: position.term,
                latestSeq: position.seq,
                latestRowVersion:
                    result?.latestRowVersion ??
                    position.rowVersion,
                requiresFullReload: true,
            };
        }
        return {
            type: "rpc:pullSince:res",
            rpcId: input.rpcId,
            ok: true,
            latestTerm: position.term,
            latestSeq: position.seq,
            latestRowVersion:
                result.latestRowVersion,
            requiresFullReload: false,
            changedKeys: result.changedKeys,
            deletedKeys: result.deletedKeys,
            deltas: result.deltas,
        };
    }

    private coordinationScope(): string {
        return "scope" in this.coordination &&
            typeof this.coordination.scope ===
                "string"
            ? this.coordination.scope
            : "party-stack";
    }
}
