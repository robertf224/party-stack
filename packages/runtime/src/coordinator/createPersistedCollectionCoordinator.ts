import {
    isCoordinationHost,
    type Coordination,
    type CoordinationServiceClient,
    type CoordinationServiceServer,
} from "@party-stack/coordination";
import {
    safeRandomUUID,
    SingleProcessCoordinator,
    toTransportedLoadSubsetOptions,
    toPersistedCollectionDurabilityError,
} from "@tanstack/db-sqlite-persistence-core";
import type { LoadSubsetOptions } from "@tanstack/db";
import type {
    ApplyLocalMutationsResponse,
    ApplyCommittedTxResponse,
    HydrationPersistenceAdapter,
    PersistedCollectionCoordinator,
    PersistedIndexSpec,
    PersistedMutationEnvelope,
    PersistenceAdapter,
    PersistedTx,
    RemoteSubsetOwner,
    ProtocolEnvelope,
    PullSinceResponse,
    ReplayableTxDelta,
} from "@tanstack/db-sqlite-persistence-core";

const PERSISTENCE_SERVICE = "party-stack.persistence.v1";
const MAX_DEDUPLICATION_ENTRIES = 1_000;
const MAX_PENDING_RELAYS = 1_000;
const MAX_COLLECTION_POSITIONS = 128;

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
    acquisitionId: string;
}

interface ApplyCommittedTxInput {
    schemaVersion?: number;
    collectionId: string;
    tx: PersistedTx;
}

interface EnsurePersistedIndexInput {
    schemaVersion?: number;
    collectionId: string;
    signature: string;
    spec: PersistedIndexSpec;
}

interface ApplyLocalMutationsInput {
    schemaVersion?: number;
    collectionId: string;
    rpcId: string;
    envelopeId: string;
    mutations: PersistedMutationEnvelope[];
}

interface PullSinceInput {
    schemaVersion?: number;
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
        ensureLeadership(input: EnsureLeadershipInput): Promise<void>;
        ensureRemoteSubset(input: EnsureRemoteSubsetInput): Promise<void>;
        releaseRemoteSubset(input: EnsureRemoteSubsetInput): Promise<void>;
        applyCommittedTx(input: ApplyCommittedTxInput): Promise<ApplyCommittedTxResponse>;
        ensurePersistedIndex(input: EnsurePersistedIndexInput): Promise<void>;
        applyLocalMutations(input: ApplyLocalMutationsInput): Promise<ApplyLocalMutationsResponse>;
        pullSince(input: PullSinceInput): Promise<PullSinceResponse>;
        relayMessage(input: RelayMessageInput): Promise<void>;
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
              latestTerm?: number;
              latestSeq?: number;
              requiresFullReload: true;
          }
        | {
              latestRowVersion: number;
              latestTerm?: number;
              latestSeq?: number;
              requiresFullReload: false;
              changedKeys: Array<string | number>;
              deletedKeys: Array<string | number>;
              deltas?: Array<ReplayableTxDelta<Record<string, unknown>, string | number>>;
          }
    >;
};

const coordinatorCache = new WeakMap<
    Coordination,
    WeakMap<PersistenceAdapter, PersistedCollectionCoordinator>
>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function relayKey(collectionId: string, message: ProtocolEnvelope<unknown>): string {
    const payload = isRecord(message.payload) ? message.payload : {};
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
    let adapters = coordinatorCache.get(coordination);
    if (!adapters) {
        adapters = new WeakMap();
        coordinatorCache.set(coordination, adapters);
    }
    const existing = adapters.get(adapter);
    if (existing) return existing;

    const created = new CoordinationPersistenceShim(coordination, adapter as AdapterWithPullSince);
    adapters.set(adapter, created);
    return created;
}

class CoordinationPersistenceShim implements PersistedCollectionCoordinator {
    private readonly nodeId = safeRandomUUID();
    private readonly collectionAdapters = new Map<string, AdapterWithPullSince>();
    private readonly collectionSubscriptions = new Map<string, number>();

    setAdapterForCollection(collectionId: string, adapter: HydrationPersistenceAdapter): void {
        this.collectionAdapters.set(collectionId, adapter);
        this.positions.delete(collectionId);
    }

    private adapterForCollection(collectionId: string, schemaVersion?: number): AdapterWithPullSince {
        const adapter = this.collectionAdapters.get(collectionId) ?? this.adapter;
        if (schemaVersion !== undefined && this.schemaVersion(adapter) !== schemaVersion) {
            throw new Error(
                `Persistence schema mismatch for collection "${collectionId}". Reload the coordination host before writing through another schema version.`
            );
        }
        return adapter;
    }

    private schemaVersion(adapter: PersistenceAdapter): number | undefined {
        return "schemaVersion" in adapter && typeof adapter.schemaVersion === "number"
            ? adapter.schemaVersion
            : undefined;
    }
    private readonly positions = new Map<string, Promise<CollectionPosition>>();
    private readonly appliedEnvelopes = new Map<string, Extract<ApplyLocalMutationsResponse, { ok: true }>>();
    private readonly relayedMessages = new Set<string>();
    private readonly service: CoordinationServiceClient<PersistenceCoordinationService>;
    private readonly server: CoordinationServiceServer<PersistenceCoordinationService> | undefined;
    private pendingRelays = 0;
    private readonly remoteSubsets = new SingleProcessCoordinator();
    private readonly acquisitionIds = new WeakMap<LoadSubsetOptions, Map<string, string>>();
    private readonly remoteAcquisitions = new Map<
        string,
        {
            collectionId: string;
            options: LoadSubsetOptions;
        }
    >();

    constructor(
        private readonly coordination: Coordination,
        private readonly adapter: AdapterWithPullSince
    ) {
        this.service = coordination.service<PersistenceCoordinationService>(PERSISTENCE_SERVICE);
        this.server = isCoordinationHost(coordination)
            ? coordination.serve<PersistenceCoordinationService>(PERSISTENCE_SERVICE, {
                  ensureLeadership: () => Promise.resolve(),
                  ensureRemoteSubset: async (input) => {
                      let options = this.remoteAcquisitions.get(input.acquisitionId)?.options;
                      if (!options) {
                          options = input.options;
                          this.remoteAcquisitions.set(input.acquisitionId, {
                              collectionId: input.collectionId,
                              options,
                          });
                      }
                      try {
                          await this.remoteSubsets.requestEnsureRemoteSubset(input.collectionId, options);
                      } catch (error) {
                          // Owner invocation transfers a lease even if loading fails.
                          // Release it before dropping our strong reference to its options.
                          if (this.remoteAcquisitions.get(input.acquisitionId)?.options === options) {
                              this.remoteAcquisitions.delete(input.acquisitionId);
                              await this.remoteSubsets.requestReleaseRemoteSubset(input.collectionId, options)
                                  .catch(() => undefined);
                          }
                          throw error;
                      }
                  },
                  releaseRemoteSubset: (input) => {
                      const options = this.remoteAcquisitions.get(input.acquisitionId)?.options;
                      this.remoteAcquisitions.delete(input.acquisitionId);
                      return options
                          ? this.remoteSubsets.requestReleaseRemoteSubset(input.collectionId, options)
                          : Promise.resolve();
                  },
                  applyCommittedTx: (input) => this.applyCommittedTx(input),
                  ensurePersistedIndex: (input) =>
                      this.adapterForCollection(input.collectionId, input.schemaVersion).ensureIndex(
                          input.collectionId,
                          input.signature,
                          input.spec
                      ),
                  applyLocalMutations: (input) => this.applyMutations(input),
                  pullSince: (input) => this.handlePullSince(input),
                  relayMessage: (input) => this.relayMessage(input),
              })
            : undefined;
    }

    getNodeId(): string {
        return this.nodeId;
    }

    subscribe(collectionId: string, callback: (message: ProtocolEnvelope<unknown>) => void): () => void {
        const unsubscribe = this.service.events.subscribe("message", (event) => {
            if (event.collectionId === collectionId) {
                callback(event.message);
            }
        });
        this.collectionSubscriptions.set(
            collectionId,
            (this.collectionSubscriptions.get(collectionId) ?? 0) + 1
        );
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            try {
                unsubscribe();
            } finally {
                const remaining = this.collectionSubscriptions.get(collectionId)! - 1;
                if (remaining > 0) {
                    this.collectionSubscriptions.set(collectionId, remaining);
                } else {
                    this.collectionSubscriptions.delete(collectionId);
                    this.collectionAdapters.delete(collectionId);
                    this.positions.delete(collectionId);
                }
            }
        };
    }

    publish(collectionId: string, message: ProtocolEnvelope<unknown>): void {
        if (this.server && isCoordinationHost(this.coordination) && this.coordination.isLeader) {
            this.publishMessage({
                collectionId,
                message,
            });
            return;
        }
        if (this.pendingRelays >= MAX_PENDING_RELAYS) {
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
                console.warn(`Failed to relay persistence message for "${collectionId}".`, error);
            })
            .finally(() => {
                this.pendingRelays -= 1;
            });
    }

    isLeader(): boolean {
        return isCoordinationHost(this.coordination) && this.coordination.isLeader;
    }

    ensureLeadership(): Promise<void> {
        return this.service.methods.ensureLeadership({
            collectionId: "*",
        });
    }

    requestEnsureRemoteSubset(collectionId: string, options: LoadSubsetOptions): Promise<void> {
        let collectionIds = this.acquisitionIds.get(options);
        if (!collectionIds) {
            collectionIds = new Map();
            this.acquisitionIds.set(options, collectionIds);
        }
        let acquisitionId = collectionIds.get(collectionId);
        if (!acquisitionId) {
            acquisitionId = safeRandomUUID();
            collectionIds.set(collectionId, acquisitionId);
        }
        return this.service.methods.ensureRemoteSubset({
            collectionId,
            options: toTransportedLoadSubsetOptions(options) as LoadSubsetOptions,
            acquisitionId,
        });
    }

    requestReleaseRemoteSubset(collectionId: string, options: LoadSubsetOptions): Promise<void> {
        const collectionIds = this.acquisitionIds.get(options);
        const acquisitionId = collectionIds?.get(collectionId);
        if (!acquisitionId) return Promise.resolve();
        collectionIds!.delete(collectionId);
        if (collectionIds!.size === 0) this.acquisitionIds.delete(options);
        return this.service.methods.releaseRemoteSubset({ collectionId, options: {}, acquisitionId });
    }

    registerRemoteSubsetOwner(collectionId: string, owner: RemoteSubsetOwner): () => void {
        const unregister = this.remoteSubsets.registerRemoteSubsetOwner(collectionId, owner);
        let registered = true;
        return () => {
            if (!registered) return;
            registered = false;
            unregister();
            for (const [id, acquisition] of this.remoteAcquisitions) {
                if (acquisition.collectionId === collectionId) this.remoteAcquisitions.delete(id);
            }
        };
    }

    requestApplyCommittedTx(
        collectionId: string,
        tx: PersistedTx,
        scopedAdapter?: HydrationPersistenceAdapter
    ): Promise<ApplyCommittedTxResponse> {
        return this.isLeader()
            ? this.applyCommittedTx({ collectionId, tx }, scopedAdapter)
            : this.service.methods.applyCommittedTx({
                  collectionId,
                  tx,
                  schemaVersion:
                      this.schemaVersion(scopedAdapter ?? this.adapterForCollection(collectionId)) ??
                      this.schemaVersion(this.adapterForCollection(collectionId)),
              });
    }

    private async applyCommittedTx(
        { collectionId, tx, schemaVersion }: ApplyCommittedTxInput,
        scopedAdapter?: HydrationPersistenceAdapter
    ): Promise<ApplyCommittedTxResponse> {
        try {
            await (scopedAdapter ?? this.adapterForCollection(collectionId, schemaVersion)).applyCommittedTx(
                collectionId,
                tx
            );
        } catch (error) {
            throw toPersistedCollectionDurabilityError(collectionId, error);
        }
        this.positions.delete(collectionId);
        return {
            type: "rpc:applyCommittedTx:res",
            rpcId: safeRandomUUID(),
            ok: true,
            term: tx.term,
            seq: tx.seq,
            latestRowVersion: tx.rowVersion,
        };
    }

    requestEnsurePersistedIndex(
        collectionId: string,
        signature: string,
        spec: PersistedIndexSpec,
        scopedAdapter?: HydrationPersistenceAdapter,
        localEnsureCompleted?: boolean
    ): Promise<void> {
        if (this.isLeader()) {
            return localEnsureCompleted
                ? Promise.resolve()
                : (scopedAdapter ?? this.adapterForCollection(collectionId)).ensureIndex(
                      collectionId,
                      signature,
                      spec
                  );
        }
        return this.service.methods.ensurePersistedIndex({
            collectionId,
            signature,
            spec,
            schemaVersion:
                this.schemaVersion(scopedAdapter ?? this.adapterForCollection(collectionId)) ??
                this.schemaVersion(this.adapterForCollection(collectionId)),
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
            schemaVersion: this.schemaVersion(this.adapterForCollection(collectionId)),
            mutations,
        });
    }

    pullSince(collectionId: string, fromRowVersion: number): Promise<PullSinceResponse> {
        return this.service.methods.pullSince({
            collectionId,
            rpcId: safeRandomUUID(),
            fromRowVersion,
            schemaVersion: this.schemaVersion(this.adapterForCollection(collectionId)),
        });
    }

    private relayMessage(input: RelayMessageInput): Promise<void> {
        const key = relayKey(input.collectionId, input.message);
        if (this.relayedMessages.has(key)) {
            return Promise.resolve();
        }
        this.relayedMessages.add(key);
        if (this.relayedMessages.size > MAX_DEDUPLICATION_ENTRIES) {
            const oldest = this.relayedMessages.values().next().value;
            if (oldest) {
                this.relayedMessages.delete(oldest);
            }
        }
        this.publishMessage(input);
        return Promise.resolve();
    }

    private publishMessage(input: RelayMessageInput): void {
        this.server?.events.publish("message", input);
    }

    private async position(collectionId: string): Promise<CollectionPosition> {
        let position = this.positions.get(collectionId);
        if (!position) {
            const adapter = this.adapterForCollection(collectionId);
            position = Promise.resolve(
                adapter.getStreamPosition
                    ? adapter.getStreamPosition(collectionId)
                    : adapter.loadResumeSnapshot(collectionId, { includeRows: false })
            ).then((current) => ({
                term: (current?.latestTerm ?? 0) + 1,
                seq: current?.latestSeq ?? 0,
                rowVersion: current?.latestRowVersion ?? 0,
            }));
        }
        this.positions.delete(collectionId);
        this.positions.set(collectionId, position);
        while (this.positions.size > MAX_COLLECTION_POSITIONS) {
            const oldest = this.positions.keys().next().value;
            if (oldest !== undefined) this.positions.delete(oldest);
        }
        void position.catch(() => {
            if (this.positions.get(collectionId) === position) this.positions.delete(collectionId);
        });
        return position;
    }

    private async applyMutations(input: ApplyLocalMutationsInput): Promise<ApplyLocalMutationsResponse> {
        const adapter = this.adapterForCollection(input.collectionId, input.schemaVersion);
        const envelopeKey = JSON.stringify([input.collectionId, input.envelopeId]);
        const previous = this.appliedEnvelopes.get(envelopeKey);
        if (previous) {
            return {
                ...previous,
                rpcId: input.rpcId,
            };
        }

        const position = await this.position(input.collectionId);
        const nextPosition = { ...position, seq: position.seq + 1, rowVersion: position.rowVersion + 1 };
        const txId = input.envelopeId;
        await adapter.applyCommittedTx(input.collectionId, {
            txId,
            term: nextPosition.term,
            seq: nextPosition.seq,
            rowVersion: nextPosition.rowVersion,
            mutations: input.mutations.map(({ mutationId, ...mutation }) => {
                void mutationId;
                return mutation;
            }),
        });
        Object.assign(position, nextPosition);
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
                latestRowVersion: position.rowVersion,
                requiresFullReload: false,
                changedRows: input.mutations
                    .filter((mutation) => mutation.type !== "delete")
                    .map((mutation) => ({
                        key: mutation.key,
                        value: mutation.value,
                    })),
                deletedKeys: input.mutations
                    .filter((mutation) => mutation.type === "delete")
                    .map((mutation) => mutation.key),
                rowMetadataMutations: input.mutations.flatMap((mutation) =>
                    mutation.type !== "delete" &&
                    (mutation.metadataChanged || mutation.metadata !== undefined)
                        ? [
                              mutation.metadata === undefined
                                  ? { type: "delete" as const, key: mutation.key }
                                  : { type: "set" as const, key: mutation.key, value: mutation.metadata },
                          ]
                        : []
                ),
            },
        };
        this.publishMessage({
            collectionId: input.collectionId,
            message: committed,
        });

        const response: Extract<ApplyLocalMutationsResponse, { ok: true }> = {
            type: "rpc:applyLocalMutations:res",
            rpcId: input.rpcId,
            ok: true,
            term: position.term,
            seq: position.seq,
            latestRowVersion: position.rowVersion,
            acceptedMutationIds: input.mutations.map((mutation) => mutation.mutationId),
        };
        this.appliedEnvelopes.set(envelopeKey, response);
        if (this.appliedEnvelopes.size > MAX_DEDUPLICATION_ENTRIES) {
            const oldest = this.appliedEnvelopes.keys().next().value;
            if (oldest) {
                this.appliedEnvelopes.delete(oldest);
            }
        }
        return response;
    }

    private async handlePullSince(input: PullSinceInput): Promise<PullSinceResponse> {
        const adapter = this.adapterForCollection(input.collectionId, input.schemaVersion);
        const current = await adapter.getStreamPosition?.(input.collectionId);
        const position = current
            ? { term: current.latestTerm, seq: current.latestSeq, rowVersion: current.latestRowVersion }
            : await this.position(input.collectionId);
        const result = await adapter.pullSince?.(input.collectionId, input.fromRowVersion);
        if (!result || result.requiresFullReload) {
            return {
                type: "rpc:pullSince:res",
                rpcId: input.rpcId,
                ok: true,
                latestTerm: result?.latestTerm ?? position.term,
                latestSeq: result?.latestSeq ?? position.seq,
                latestRowVersion: result?.latestRowVersion ?? position.rowVersion,
                requiresFullReload: true,
            };
        }
        return {
            type: "rpc:pullSince:res",
            rpcId: input.rpcId,
            ok: true,
            latestTerm: result?.latestTerm ?? position.term,
            latestSeq: result?.latestSeq ?? position.seq,
            latestRowVersion: result.latestRowVersion,
            requiresFullReload: false,
            changedKeys: result.changedKeys,
            deletedKeys: result.deletedKeys,
            deltas: result.deltas,
        };
    }

    private coordinationScope(): string {
        return "scope" in this.coordination && typeof this.coordination.scope === "string"
            ? this.coordination.scope
            : "party-stack";
    }
}
