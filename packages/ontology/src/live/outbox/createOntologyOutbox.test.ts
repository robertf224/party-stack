import {
    type CoordinationCallOptions,
    type CoordinationClient,
    type CoordinationHost,
    type CoordinationService,
    type CoordinationServiceClient,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
    MemoryBlobBytesStore,
    type NetworkConnectivity,
    type PersistenceAdapter,
    type RuntimeAdapter,
    SingleProcessCoordination,
} from "@party-stack/runtime";
import { Temporal } from "temporal-polyfill";
import {
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { createOntologyOutbox } from "./createOntologyOutbox.js";
import { OUTBOX_COORDINATION_SERVICE, type OutboxCoordinationService } from "./service.js";
import { NonRetryableError } from "./types.js";
import type { OntologyOutboxEntry } from "./types.js";

class TestNetworkConnectivity implements NetworkConnectivity {
    private readonly listeners = new Set<(isConnected: boolean) => void>();

    constructor(private connected = true) {}

    get isConnected(): boolean {
        return this.connected;
    }

    setConnected(isConnected: boolean): void {
        if (isConnected === this.connected) return;
        this.connected = isConnected;
        for (const listener of this.listeners) {
            listener(isConnected);
        }
    }

    subscribe(listener: (isConnected: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    close(): void {
        this.listeners.clear();
    }
}

function memoryPersistenceAdapter(): PersistenceAdapter {
    const rows = new Map<string | number, Record<string, unknown>>();
    return {
        loadSubset: () =>
            Promise.resolve(
                [...rows].map(([key, value]) => ({
                    key,
                    value,
                }))
            ),
        applyCommittedTx: (
            _collectionId: string,
            transaction: Parameters<PersistenceAdapter["applyCommittedTx"]>[1]
        ) => {
            if (transaction.truncate) rows.clear();
            for (const mutation of transaction.mutations) {
                if (mutation.type === "delete") {
                    rows.delete(mutation.key);
                } else {
                    rows.set(mutation.key, mutation.value);
                }
            }
            return Promise.resolve();
        },
        ensureIndex: () => Promise.resolve(),
    };
}

function coordinatedOutboxRuntime(options: {
    adapter: PersistenceAdapter;
    connectivity: NetworkConnectivity;
    coordination: CoordinationHost | CoordinationClient;
}): {
    runtime: RuntimeAdapter;
    coordination: CoordinationHost | CoordinationClient;
} {
    const runtime: RuntimeAdapter = {
        owner: "test-user",
        namespace: "outbox-test",
        blobBytes: new MemoryBlobBytesStore(),
        connectivity: options.connectivity,
        persistence: options.adapter,
        coordination: options.coordination,
    };
    return {
        runtime,
        coordination: options.coordination,
    };
}

function createSingleProcessRuntime(
    options: Omit<
        RuntimeAdapter,
        "coordination" | "owner" | "namespace"
    > &
        Partial<
            Pick<
                RuntimeAdapter,
                "owner" | "namespace"
            >
        >,
    scope: string
): {
    runtime: RuntimeAdapter;
    coordination: SingleProcessCoordination;
} {
    const coordination = new SingleProcessCoordination({
        scope,
    });
    return {
        runtime: {
            ...options,
            owner: options.owner ?? "test-user",
            namespace: options.namespace ?? scope,
            coordination,
        },
        coordination,
    };
}

function clientView(host: CoordinationHost): CoordinationClient {
    return {
        role: "client",
        service: <Service extends CoordinationService>(
            namespace: string
        ): CoordinationServiceClient<Service> => host.service<Service>(namespace),
        close: () => Promise.resolve(),
    };
}

class TestLeadershipCoordination implements CoordinationHost {
    readonly role = "host" as const;
    private readonly delegate: SingleProcessCoordination;
    private leading = true;
    private active?: AbortController;
    private readonly waiters = new Set<() => void>();

    constructor(scope: string) {
        this.delegate = new SingleProcessCoordination({
            scope,
        });
    }

    get isLeader(): boolean {
        return this.leading;
    }

    get waitingForLeadership(): boolean {
        return this.waiters.size > 0;
    }

    service<Service extends CoordinationService>(namespace: string): CoordinationServiceClient<Service> {
        return this.delegate.service<Service>(namespace);
    }

    serve<Service extends CoordinationService>(
        namespace: string,
        handlers: CoordinationServiceHandlers<Service>
    ): CoordinationServiceServer<Service> {
        return this.delegate.serve(namespace, handlers);
    }

    async runAsLeader<Result>(
        callback: (context: { signal: AbortSignal }) => Result | Promise<Result>,
        options?: CoordinationCallOptions
    ): Promise<Result> {
        await this.waitForLeadership(options?.signal);
        const controller = new AbortController();
        const abort = () => controller.abort(options?.signal?.reason);
        options?.signal?.addEventListener("abort", abort, {
            once: true,
        });
        this.active = controller;
        try {
            return await callback({
                signal: controller.signal,
            });
        } finally {
            options?.signal?.removeEventListener("abort", abort);
            if (this.active === controller) {
                this.active = undefined;
            }
        }
    }

    loseLeadership(): void {
        this.leading = false;
        this.active?.abort(new Error("Test leadership lost."));
    }

    regainLeadership(): void {
        this.leading = true;
        for (const wake of this.waiters) wake();
        this.waiters.clear();
    }

    async close(): Promise<void> {
        this.loseLeadership();
        await this.delegate.close();
    }

    private waitForLeadership(signal?: AbortSignal): Promise<void> {
        if (this.leading) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const wake = () => {
                signal?.removeEventListener("abort", abort);
                resolve();
            };
            const abort = () => {
                this.waiters.delete(wake);
                reject(
                    signal?.reason instanceof Error ? signal.reason : new Error("Leadership wait aborted.")
                );
            };
            this.waiters.add(wake);
            signal?.addEventListener("abort", abort, {
                once: true,
            });
            if (signal?.aborted) abort();
        });
    }
}

function setup(isConnected = true) {
    const connectivity = new TestNetworkConnectivity(isConnected);
    const execute = vi.fn(() => Promise.resolve("done"));
    const { runtime, coordination } =
        createSingleProcessRuntime(
            {
                blobBytes:
                    new MemoryBlobBytesStore(),
                connectivity,
            },
            `setup-${crypto.randomUUID()}`
        );
    const outbox = createOntologyOutbox({
        runtime,
        execute,
    });
    return {
        connectivity,
        coordination,
        execute,
        outbox,
    };
}

describe("createOntologyOutbox", () => {
    it("persists before executing and removes completed work", async () => {
        const { execute, outbox } = setup();
        await outbox.ready;

        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { title: "Test" },
        });

        await expect(action.completed).resolves.toBe("done");
        expect(execute).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(outbox.collection.size).toBe(0);
        });
        await outbox.cleanup();
    });

    it("waits until connectivity is restored", async () => {
        const { connectivity, execute, outbox } = setup(false);
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });

        await Promise.resolve();
        expect(execute).not.toHaveBeenCalled();

        connectivity.setConnected(true);
        await expect(action.completed).resolves.toBe("done");
        expect(execute).toHaveBeenCalledOnce();
        await outbox.cleanup();
    });

    it("edits and removes queued work", async () => {
        const { connectivity, outbox } = setup(false);
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { title: "Before" },
        });

        await outbox.edit(action.entry.id, (request) => {
            request.parameters.title = "After";
        });
        expect(outbox.collection.get(action.entry.id)?.request.parameters.title).toBe("After");

        await outbox.remove(action.entry.id);
        await expect(action.completed).rejects.toThrow("removed");
        expect(outbox.collection.has(action.entry.id)).toBe(false);
        connectivity.close();
        await outbox.cleanup();
    });

    it("installs one projection when enqueue and collection change race", async () => {
        const project = vi.fn(async () => {
            await Promise.resolve();
            return {
                settle: vi.fn(),
            };
        });
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(
                            false
                        ),
                },
                "projection-race"
            );
        const outbox = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
            project,
        });
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { id: "one" },
        });
        void action.completed.catch(() => undefined);

        expect(project).toHaveBeenCalledOnce();
        await outbox.cleanup();
    });

    it("keeps durable intent when local projection fails", async () => {
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(
                            false
                        ),
                },
                "projection-discard"
            );
        const outbox = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
            project: () =>
                Promise.reject(
                    new Error("cannot project")
                ),
        });
        await outbox.ready;

        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });
        void action.completed.catch(
            () => undefined
        );
        const entry = outbox.collection.get(
            action.entry.id
        );
        expect(entry?.status).toBe("queued");
        expect(entry?.lastError).toBeUndefined();
        await outbox.cleanup();
    });

    it("requires manual retry after execution failure", async () => {
        let attempts = 0;
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(),
                },
                "manual-retry"
            );
        const outbox = createOntologyOutbox({
            runtime,
            maxRetries: 0,
            failureStrategy: "pause",
            execute: () => {
                attempts += 1;
                return attempts === 1 ? Promise.reject(new Error("failed")) : Promise.resolve("done");
            },
        });
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });
        await vi.waitFor(() => {
            expect(outbox.collection.get(action.entry.id)?.status).toBe("failed");
        });
        expect(attempts).toBe(1);

        await outbox.retry(action.entry.id);
        await expect(action.completed).resolves.toBe("done");
        expect(attempts).toBe(2);
        await outbox.cleanup();
    });

    it("automatically retries ordinary execution failures with backoff", async () => {
        let attempts = 0;
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(),
                },
                "automatic-retry"
            );
        const outbox = createOntologyOutbox({
            runtime,
            maxRetries: 3,
            execute: () => {
                attempts += 1;
                return attempts < 3
                    ? Promise.reject(
                          new Error("temporary")
                      )
                    : Promise.resolve("done");
            },
        });
        await outbox.ready;
        const action = await outbox.enqueue<string>({
            actionTypeName: "createTask",
            parameters: {},
        });

        await expect(action.completed).resolves.toBe(
            "done"
        );
        expect(attempts).toBe(3);
        expect(
            outbox.collection.get(action.entry.id)
        ).toBeUndefined();
        await outbox.cleanup();
    });

    it("applies the failure strategy after automatic retries are exhausted", async () => {
        let attempts = 0;
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(),
                },
                "automatic-retry-exhausted"
            );
        const outbox = createOntologyOutbox({
            runtime,
            maxRetries: 2,
            execute: () => {
                attempts += 1;
                return Promise.reject(
                    new Error("still failing")
                );
            },
        });
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });

        await expect(action.completed).rejects.toThrow(
            "still failing"
        );
        expect(attempts).toBe(3);
        expect(
            outbox.collection.get(action.entry.id)
        ).toBeUndefined();
        await outbox.cleanup();
    });

    it("keeps a failed head ahead of later queued entries", async () => {
        const executed: string[] = [];
        let firstAttempts = 0;
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(),
                },
                "strict-fifo"
            );
        const outbox = createOntologyOutbox({
            runtime,
            maxRetries: 0,
            failureStrategy: "pause",
            execute: (entry) => {
                const name = String(entry.request.parameters.name);
                executed.push(name);
                if (name === "first" && firstAttempts++ === 0) {
                    return Promise.reject(new Error("first failed"));
                }
                return Promise.resolve(name);
            },
        });
        await outbox.ready;
        const first = await outbox.enqueue<string>({
            actionTypeName: "createTask",
            parameters: { name: "first" },
        });
        await vi.waitFor(() => {
            expect(outbox.collection.get(first.entry.id)?.status).toBe("failed");
        });
        const second = await outbox.enqueue<string>({
            actionTypeName: "createTask",
            parameters: { name: "second" },
        });

        await Promise.resolve();
        expect(executed).toEqual(["first"]);
        expect(outbox.collection.get(second.entry.id)?.status).toBe("queued");

        await outbox.retry(first.entry.id);
        await expect(first.completed).resolves.toBe("first");
        await expect(second.completed).resolves.toBe("second");
        expect(executed).toEqual(["first", "first", "second"]);
        await outbox.cleanup();
    });

    it("releases a failed FIFO head when it is removed", async () => {
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(),
                },
                "remove-failed-head"
            );
        const outbox = createOntologyOutbox({
            runtime,
            maxRetries: 0,
            failureStrategy: "pause",
            execute: (entry) => {
                const name = String(entry.request.parameters.name);
                return name === "first" ? Promise.reject(new Error("blocked")) : Promise.resolve(name);
            },
        });
        await outbox.ready;
        const first = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { name: "first" },
        });
        await vi.waitFor(() => {
            expect(outbox.collection.get(first.entry.id)?.status).toBe("failed");
        });
        const second = await outbox.enqueue<string>({
            actionTypeName: "createTask",
            parameters: { name: "second" },
        });

        await outbox.remove(first.entry.id);
        await expect(first.completed).rejects.toThrow("removed");
        await expect(second.completed).resolves.toBe("second");

        await outbox.cleanup();
        await runtime.coordination.close();
    });

    it("rolls back and pauses on non-retryable failures when configured", async () => {
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(),
                },
                "non-retriable"
            );
        const outbox = createOntologyOutbox({
            runtime,
            execute: () => Promise.reject(new NonRetryableError("rejected")),
            failureStrategy: "pause",
        });
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });

        await expect(action.completed).rejects.toThrow("rejected");
        await vi.waitFor(() => {
            expect(outbox.collection.get(action.entry.id)?.retryable).toBe(false);
        });
        await expect(outbox.retry(action.entry.id)).rejects.toThrow("not retriable");
        await outbox.cleanup();
    });

    it("discards the remaining queue on non-retryable failures by default", async () => {
        const connectivity =
            new TestNetworkConnectivity(false);
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity,
                },
                "non-retryable-discard"
            );
        const settled = new Set<string>();
        const outbox = createOntologyOutbox({
            runtime,
            execute: () =>
                Promise.reject(
                    new NonRetryableError(
                        "rejected"
                    )
                ),
            project: (entry) =>
                Promise.resolve({
                    settle(error) {
                        expect(error).toBeDefined();
                        settled.add(
                            String(
                                entry.request.parameters
                                    .order
                            )
                        );
                    },
                }),
        });
        await outbox.ready;
        const first = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { order: 1 },
        });
        const second = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { order: 2 },
        });
        const deleteEntries = vi.spyOn(
            outbox.collection,
            "delete"
        );

        connectivity.setConnected(true);

        await expect(first.completed).rejects.toThrow(
            "rejected"
        );
        await expect(second.completed).rejects.toThrow(
            "failed permanently"
        );
        await vi.waitFor(() => {
            expect(
                outbox.collection.get(first.entry.id)
            ).toBeUndefined();
            expect(
                outbox.collection.get(second.entry.id)
            ).toBeUndefined();
        });
        expect(settled).toEqual(
            new Set(["1", "2"])
        );
        expect(deleteEntries).toHaveBeenCalledOnce();
        expect(deleteEntries).toHaveBeenCalledWith(
            [first.entry.id, second.entry.id],
            { optimistic: false }
        );
        await outbox.cleanup();
    });

    it("discards previously interrupted work during recovery by default", async () => {
        const adapter = memoryPersistenceAdapter();
        const { runtime, coordination } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(
                            false
                        ),
                    persistence: adapter,
                },
                "interrupted-recovery-discard"
            );
        const first = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
        });
        await first.ready;
        const action = await first.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });
        void action.completed.catch(
            () => undefined
        );
        await first.collection.update(
            action.entry.id,
            { optimistic: false },
            (draft) => {
                draft.status = "failed";
                draft.retryable = true;
                draft.lastError = {
                    name: "InterruptedExecution",
                    message:
                        "Execution was interrupted; retry manually.",
                };
            }
        ).isPersisted.promise;
        await first.cleanup();

        const restored = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
        });
        await restored.ready;
        await vi.waitFor(() => {
            expect(
                restored.collection.get(
                    action.entry.id
                )
            ).toBeUndefined();
        });

        await restored.cleanup();
        await coordination.close();
    });

    it("resumes retryable failed work during recovery", async () => {
        const adapter = memoryPersistenceAdapter();
        const connectivity =
            new TestNetworkConnectivity(false);
        const { runtime, coordination } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        connectivity,
                    persistence: adapter,
                },
                "failed-recovery-retry"
            );
        const first = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
        });
        await first.ready;
        const action = await first.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });
        void action.completed.catch(
            () => undefined
        );
        await first.collection.update(
            action.entry.id,
            { optimistic: false },
            (draft) => {
                draft.status = "failed";
                draft.retryable = true;
                draft.attempts = 1;
                draft.lastError = {
                    name: "Error",
                    message: "temporary",
                };
            }
        ).isPersisted.promise;
        await first.cleanup();

        const execute = vi.fn(() =>
            Promise.resolve("done")
        );
        connectivity.setConnected(true);
        const restored = createOntologyOutbox({
            runtime,
            execute,
        });
        await restored.ready;
        await vi.waitFor(() => {
            expect(execute).toHaveBeenCalledOnce();
            expect(
                restored.collection.get(
                    action.entry.id
                )
            ).toBeUndefined();
        });

        await restored.cleanup();
        await coordination.close();
    });

    it("keeps restored intent when optimistic projection is unavailable", async () => {
        const adapter = memoryPersistenceAdapter();
        const connectivity = new TestNetworkConnectivity(false);
        const { runtime } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity,
                    persistence: adapter,
                },
                "projection-restart"
            );
        const first = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
        });
        await first.ready;
        const action = await first.enqueue({
            actionTypeName: "deleteTask",
            parameters: { task: "missing" },
        });
        void action.completed.catch(() => undefined);
        await first.cleanup();

        const restored = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
            project: () =>
                Promise.reject(
                    new Error(
                        "Collection.delete was called with key 'missing' but there is no item in the collection with this key"
                    )
                ),
        });

        await expect(restored.ready).resolves.toBeUndefined();
        const entry = restored.collection.get(
            action.entry.id
        );
        expect(entry?.status).toBe("queued");
        expect(entry?.lastError).toBeUndefined();
        await restored.remove(action.entry.id);
        expect(restored.collection.has(action.entry.id)).toBe(false);
        await restored.cleanup();
        await runtime.coordination.close();
        connectivity.close();
    });

    it("uses a client-only coordination value without serving", async () => {
        const adapter = memoryPersistenceAdapter();
        const hostCoordination = new SingleProcessCoordination({
            scope: "client-only",
        });
        const clientCoordination = clientView(hostCoordination);
        const hostRuntime: RuntimeAdapter = {
            owner: "test-user",
            namespace: "client-only",
            blobBytes: new MemoryBlobBytesStore(),
            connectivity: new TestNetworkConnectivity(false),
            persistence: adapter,
            coordination: hostCoordination,
        };
        const clientRuntime: RuntimeAdapter = {
            owner: "test-user",
            namespace: "client-only",
            blobBytes: new MemoryBlobBytesStore(),
            connectivity: new TestNetworkConnectivity(false),
            persistence: adapter,
            coordination: clientCoordination,
        };
        const host = createOntologyOutbox({
            runtime: hostRuntime,
            execute: () => Promise.resolve("done"),
        });
        await host.ready;
        const client = createOntologyOutbox({
            runtime: clientRuntime,
            execute: () => Promise.reject(new Error("Client execution must not run.")),
        });
        await client.ready;

        const action = await client.enqueue({
            actionTypeName: "createTask",
            parameters: { id: "client" },
        });
        await vi.waitFor(() => {
            expect(host.collection.has(action.entry.id)).toBe(true);
        });
        await host.remove(action.entry.id);
        await expect(action.completed).rejects.toThrow("Outbox entry removed");

        await client.cleanup();
        await host.cleanup();
        await hostCoordination.close();
    });

    it("discards interrupted execution when leadership is regained", async () => {
        const coordination = new TestLeadershipCoordination("leadership-cancellation");
        const runtime: RuntimeAdapter = {
            owner: "test-user",
            namespace: "leadership-cancellation",
            blobBytes: new MemoryBlobBytesStore(),
            connectivity: new TestNetworkConnectivity(true),
            coordination,
        };
        const never = new Promise<unknown>(() => undefined);
        const execute = vi.fn(() => never);
        const outbox = createOntologyOutbox({
            runtime,
            execute,
        });
        await outbox.ready;
        const action = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: {},
        });
        void action.completed.catch(() => undefined);
        await vi.waitFor(() => {
            expect(outbox.collection.get(action.entry.id)?.status).toBe("executing");
            expect(execute).toHaveBeenCalledOnce();
        });

        coordination.loseLeadership();
        await vi.waitFor(() => {
            expect(coordination.waitingForLeadership).toBe(true);
        });
        coordination.regainLeadership();

        await expect(action.completed).rejects.toThrow(
            "execution was interrupted"
        );
        expect(
            outbox.collection.get(action.entry.id)
        ).toBeUndefined();
        await outbox.cleanup();
        await coordination.close();
    });

    it("rejects a completion from a stale execution claim", async () => {
        const { runtime, coordination } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(
                            false
                        ),
                },
                "stale-claim"
            );
        const outbox = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
        });
        await outbox.ready;
        const service = coordination.service<OutboxCoordinationService>(OUTBOX_COORDINATION_SERVICE);
        const action = await outbox.enqueue<string>({
            actionTypeName: "createTask",
            parameters: {},
        });
        const stale = await service.methods.claim({});
        expect(stale?.executionId).toBeDefined();

        await service.methods.recover({
            failureStrategy: "pause",
            maxRetries: 3,
        });
        await service.methods.retry({
            id: action.entry.id,
        });
        const current = await service.methods.claim({});
        expect(current?.executionId).not.toBe(stale?.executionId);

        await expect(
            service.methods.complete({
                id: action.entry.id,
                executionId: stale!.executionId!,
                result: "stale",
            })
        ).rejects.toMatchObject({
            code: "STALE_EXECUTION",
        });
        await service.methods.complete({
            id: action.entry.id,
            executionId: current!.executionId!,
            result: "current",
        });
        await expect(action.completed).resolves.toBe("current");

        await outbox.cleanup();
        await coordination.close();
    });

    it("rolls back and replays later projections after edits and removals", async () => {
        const projections: Array<{
            name: string;
            settle: ReturnType<typeof vi.fn>;
        }> = [];
        const { runtime, coordination } =
            createSingleProcessRuntime(
                {
                    blobBytes:
                        new MemoryBlobBytesStore(),
                    connectivity:
                        new TestNetworkConnectivity(
                            false
                        ),
                },
                "projection-replay"
            );
        const outbox = createOntologyOutbox({
            runtime,
            execute: () => Promise.resolve(),
            project: (entry) => {
                const projection = {
                    name: String(entry.request.parameters.name),
                    settle: vi.fn(),
                };
                projections.push(projection);
                return Promise.resolve(projection);
            },
        });
        await outbox.ready;
        const first = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { name: "first" },
        });
        const second = await outbox.enqueue({
            actionTypeName: "createTask",
            parameters: { name: "second" },
        });
        void first.completed.catch(() => undefined);
        void second.completed.catch(() => undefined);

        await outbox.edit(first.entry.id, (request) => {
            request.parameters.name = "first-edited";
        });
        await vi.waitFor(() => {
            expect(projections.map((projection) => projection.name)).toEqual([
                "first",
                "second",
                "first-edited",
                "second",
            ]);
        });
        expect(projections[0]!.settle).toHaveBeenCalledOnce();
        expect(projections[1]!.settle).toHaveBeenCalledOnce();

        await outbox.remove(first.entry.id);
        await vi.waitFor(() => {
            expect(projections.map((projection) => projection.name)).toEqual([
                "first",
                "second",
                "first-edited",
                "second",
                "second",
            ]);
        });

        await outbox.remove(second.entry.id);
        await outbox.cleanup();
        await coordination.close();
    });

    it("preserves Temporal parameters across coordinated contexts", async () => {
        const adapter = memoryPersistenceAdapter();
        const hostCoordination =
            new SingleProcessCoordination({
                scope: "temporal",
            });
        const firstRuntime = coordinatedOutboxRuntime({
            adapter,
            coordination: hostCoordination,
            connectivity:
                new TestNetworkConnectivity(true),
        });
        const secondRuntime = coordinatedOutboxRuntime({
            adapter,
            coordination:
                clientView(hostCoordination),
            connectivity:
                new TestNetworkConnectivity(true),
        });
        let observed: unknown;
        const execute = (
            entry: OntologyOutboxEntry
        ) => {
            observed =
                entry.request.parameters.__now;
            return Promise.resolve("done");
        };
        const create = ({
            runtime,
        }: ReturnType<typeof coordinatedOutboxRuntime>) =>
            createOntologyOutbox({
                runtime,
                execute,
            });
        const first = create(firstRuntime);
        const second = create(secondRuntime);
        await Promise.all([first.ready, second.ready]);
        const origin = second;
        const instant = Temporal.Instant.from(
            "2026-07-27T12:00:00Z"
        );

        const action = await origin.enqueue({
            actionTypeName: "createTask",
            parameters: { __now: instant },
        });

        await expect(action.completed).resolves.toBe(
            "done"
        );
        expect(observed).toBeInstanceOf(
            Temporal.Instant
        );
        expect(String(observed)).toBe(
            "2026-07-27T12:00:00Z"
        );
        await first.cleanup();
        await second.cleanup();
        await hostCoordination.close();
    });

    it("serializes cross-context removal through the coordination leader", async () => {
        const adapter = memoryPersistenceAdapter();
        const hostCoordination =
            new SingleProcessCoordination({
                scope: "coordinated",
            });
        const firstRuntime = coordinatedOutboxRuntime({
            adapter,
            coordination: hostCoordination,
            connectivity: new TestNetworkConnectivity(false),
        });
        const secondRuntime = coordinatedOutboxRuntime({
            adapter,
            coordination:
                clientView(hostCoordination),
            connectivity: new TestNetworkConnectivity(false),
        });
        const create = ({ runtime }: ReturnType<typeof coordinatedOutboxRuntime>) =>
            createOntologyOutbox({
                runtime,
                execute: () => Promise.resolve("done"),
            });
        const first = create(firstRuntime);
        const second = create(secondRuntime);
        await Promise.all([first.ready, second.ready]);
        const origin = second;
        const other = first;
        const action = await origin.enqueue({
            actionTypeName: "deleteTask",
            parameters: { task: "one" },
        });
        await vi.waitFor(() => {
            expect(first.collection.has(action.entry.id)).toBe(true);
            expect(second.collection.has(action.entry.id)).toBe(true);
        });

        await other.remove(action.entry.id);
        await expect(action.completed).rejects.toThrow("Outbox entry removed");
        await vi.waitFor(() => {
            expect(first.collection.has(action.entry.id)).toBe(false);
            expect(second.collection.has(action.entry.id)).toBe(false);
        });

        await first.cleanup();
        await second.cleanup();
        await hostCoordination.close();
    });

    it("rejects removal after the leader has claimed an entry", async () => {
        const adapter = memoryPersistenceAdapter();
        const hostCoordination =
            new SingleProcessCoordination({
                scope: "claimed",
            });
        const firstRuntime = coordinatedOutboxRuntime({
            adapter,
            coordination: hostCoordination,
            connectivity: new TestNetworkConnectivity(true),
        });
        const secondRuntime = coordinatedOutboxRuntime({
            adapter,
            coordination:
                clientView(hostCoordination),
            connectivity: new TestNetworkConnectivity(true),
        });
        let finishExecution!: (value: string) => void;
        const execution = new Promise<string>((resolve) => {
            finishExecution = resolve;
        });
        const execute = vi.fn(() => execution);
        const create = ({ runtime }: ReturnType<typeof coordinatedOutboxRuntime>) =>
            createOntologyOutbox({
                runtime,
                execute,
            });
        const first = create(firstRuntime);
        const second = create(secondRuntime);
        await Promise.all([first.ready, second.ready]);
        const origin = second;
        const other = first;
        const action = await origin.enqueue({
            actionTypeName: "deleteTask",
            parameters: { task: "one" },
        });
        await vi.waitFor(() => {
            expect(first.collection.get(action.entry.id)?.status).toBe("executing");
            expect(second.collection.get(action.entry.id)?.status).toBe("executing");
        });

        await expect(other.remove(action.entry.id)).rejects.toThrow(
            "cannot be removed while it is executing"
        );
        finishExecution("done");
        await expect(action.completed).resolves.toBe("done");
        expect(execute).toHaveBeenCalledOnce();

        await first.cleanup();
        await second.cleanup();
        await hostCoordination.close();
    });
});
