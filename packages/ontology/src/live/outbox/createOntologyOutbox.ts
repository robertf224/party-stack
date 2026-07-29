import {
    createLocalCollection,
    isCoordinationHost,
    CoordinationError,
    type CoordinationServiceServer,
    type RuntimeAdapter,
} from "@party-stack/runtime";
import { useConnectivityChanges } from "@party-stack/runtime/effection";
import {
    createSignal,
    each,
    resource,
    run,
    spawn,
    suspend,
    until,
    useAbortSignal,
    type Operation,
    type Task,
} from "effection";
import { runOutboxLeader, type OutboxLeaderOptions } from "./leaderExecutor.js";
import { serveOntologyOutbox } from "./outboxService.js";
import { decodeOutboxEntry, decodeOutboxRequest, encodeOutboxRequest } from "./outboxValues.js";
import { OutboxProjectionManager, type OutboxProjection } from "./projectionManager.js";
import { OntologyOutboxRepository } from "./repository.js";
import {
    OUTBOX_COORDINATION_SERVICE,
    type OutboxCoordinationService,
    type OutboxResultEvent,
} from "./service.js";
import type {
    EnqueuedOntologyAction,
    OntologyActionRequest,
    OntologyOutbox,
    OntologyOutboxEntry,
} from "./types.js";
import type { Collection } from "@tanstack/db";

export type { OutboxProjection } from "./projectionManager.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface CreateOntologyOutboxOptions {
    runtime: RuntimeAdapter;
    execute(entry: OntologyOutboxEntry): Promise<unknown>;
    project?(entry: OntologyOutboxEntry): Promise<OutboxProjection | undefined>;
    failureStrategy?: "pause" | "discard-all";
    maxRetries?: number;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
    return resolved;
}

interface Deferred<T> {
    promise: Promise<T>;
    settled: boolean;
    resolve(value: T): void;
    reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: Error) => void;
    const value: Deferred<T> = {
        promise: undefined as unknown as Promise<T>,
        settled: false,
        resolve(result) {
            if (value.settled) return;
            value.settled = true;
            resolvePromise(result);
        },
        reject(error) {
            if (value.settled) return;
            value.settled = true;
            rejectPromise(error);
        },
    };
    value.promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return value;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function eventError(event: Extract<OutboxResultEvent, { type: "rejected" }>): Error {
    const error = new Error(event.error.message);
    error.name = event.error.name;
    return error;
}

function createOutboxCollection(
    options: CreateOntologyOutboxOptions
): Collection<OntologyOutboxEntry, string> {
    return createLocalCollection<OntologyOutboxEntry, string>({
        name: "ontology-outbox",
        getKey: (entry) => entry.id,
        runtime: options.runtime,
        schemaVersion: 1,
    });
}

export function useOntologyOutbox(
    options: CreateOntologyOutboxOptions,
    collection: Collection<OntologyOutboxEntry, string> = createOutboxCollection(options)
): Operation<OntologyOutbox> {
    return resource(function* (provide) {
        const repository = new OntologyOutboxRepository(collection);
        const failureStrategy = options.failureStrategy ?? "discard-all";
        const service =
            options.runtime.coordination.service<OutboxCoordinationService>(OUTBOX_COORDINATION_SERVICE);
        const wake = createSignal<void>();
        const projections = new OutboxProjectionManager(
            options.project ? async (entry) => options.project?.(decodeOutboxEntry(entry)) : undefined
        );
        const completions = new Map<string, Deferred<unknown>>();
        const lifetime: {
            server?: CoordinationServiceServer<OutboxCoordinationService>;
            unsubscribeResults?: () => void;
            unsubscribeCollection?: {
                unsubscribe(): void;
            };
            connectivityTask?: Task<void>;
            leaderTask?: Task<void>;
            leaderRun?: Promise<unknown>;
        } = {};
        let disposing = false;
        let reconciliationVersion = 0;

        const discardProjection = (id: string, error?: Error) => {
            void projections.discard(id, error);
        };
        const deliverResult = (event: OutboxResultEvent) => {
            const completion = completions.get(event.id);
            if (event.type === "completed") {
                discardProjection(event.id);
                if (completion) {
                    completions.delete(event.id);
                    completion.resolve(event.result);
                }
                return;
            }

            const error = eventError(event);
            discardProjection(event.id, error);
            if (completion) {
                completions.delete(event.id);
                completion.reject(error);
            }
        };
        try {
            lifetime.unsubscribeResults = service.events.subscribe("result", deliverResult);

            yield* until(repository.preload());
            if (isCoordinationHost(options.runtime.coordination)) {
                lifetime.server = serveOntologyOutbox(options.runtime.coordination, repository);
            }

            const reconcileProjections = async (): Promise<void> => {
                const version = ++reconciliationVersion;
                const entries = await repository.entries();
                if (disposing || version !== reconciliationVersion) {
                    return;
                }
                await projections.reconcile(entries);
            };
            lifetime.unsubscribeCollection = collection.subscribeChanges(() => {
                wake.send();
                void reconcileProjections();
            });

            const existing = yield* until(repository.entries());
            yield* until(projections.restore(existing));

            const connectivityChanges = yield* useConnectivityChanges(options.runtime);
            lifetime.connectivityTask = yield* spawn(function* () {
                for (const isConnected of yield* each(connectivityChanges)) {
                    void isConnected;
                    wake.send();
                    yield* each.next();
                }
            });

            if (isCoordinationHost(options.runtime.coordination)) {
                const host = options.runtime.coordination;
                const leaderOptions: OutboxLeaderOptions = {
                    runtime: options.runtime,
                    service,
                    wake,
                    failureStrategy: failureStrategy,
                    maxRetries: nonNegativeInteger(
                        options.maxRetries,
                        DEFAULT_MAX_RETRIES,
                        "Outbox maxRetries"
                    ),
                    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
                    execute: (entry) => options.execute(decodeOutboxEntry(entry)),
                };
                lifetime.leaderTask = yield* spawn(function* () {
                    const lifetimeSignal = yield* useAbortSignal();
                    while (!lifetimeSignal.aborted) {
                        try {
                            const leaderRun = host.runAsLeader(
                                ({ signal }) => runOutboxLeader(signal, leaderOptions),
                                {
                                    signal: lifetimeSignal,
                                }
                            );
                            lifetime.leaderRun = leaderRun;
                            yield* until(leaderRun);
                            return;
                        } catch (error) {
                            if (lifetimeSignal.aborted) {
                                return;
                            }
                            if (!host.isLeader && !(error instanceof CoordinationError)) {
                                continue;
                            }
                            throw error;
                        }
                    }
                });
            }

            const outbox: OntologyOutbox = {
                collection,
                ready: Promise.resolve(),
                async enqueue<Result>(
                    request: Omit<OntologyActionRequest, "idempotencyKey"> & {
                        idempotencyKey?: string;
                    },
                    enqueueOptions?: {
                        visibility?: "confirmed" | "optimistic";
                    }
                ) {
                    const timestamp = Date.now();
                    const proposed: OntologyOutboxEntry = {
                        id: crypto.randomUUID(),
                        sequence: 0,
                        request: encodeOutboxRequest({
                            ...request,
                            idempotencyKey: request.idempotencyKey ?? crypto.randomUUID(),
                        }),
                        visibility: enqueueOptions?.visibility ?? "confirmed",
                        status: "queued",
                        createdAt: timestamp,
                        updatedAt: timestamp,
                        attempts: 0,
                        retryable: true,
                        nextAttemptAt: timestamp,
                    };
                    const completion = deferred<Result>();
                    void completion.promise.catch(() => undefined);
                    completions.set(proposed.id, completion as Deferred<unknown>);

                    let entry: OntologyOutboxEntry;
                    try {
                        entry = await service.methods.enqueue({
                            entry: proposed,
                        });
                    } catch (error) {
                        completions.delete(proposed.id);
                        completion.reject(normalizeError(error));
                        throw error;
                    }

                    await projections.ensure(entry);

                    return {
                        entry: decodeOutboxEntry(entry),
                        completed: completion.promise,
                    } as EnqueuedOntologyAction<Result>;
                },
                async edit(id, update) {
                    const current = repository.get(id);
                    if (!current) {
                        throw new Error(`Outbox entry "${id}" was not found in this context.`);
                    }
                    const request = structuredClone(decodeOutboxRequest(current.request));
                    update(request);
                    const entry = await service.methods.edit({
                        id,
                        request: encodeOutboxRequest(request),
                    });
                    await projections.ensure(entry);
                    return decodeOutboxEntry(entry);
                },
                async remove(id) {
                    await service.methods.remove({ id });
                },
                async retry(id) {
                    await service.methods.retry({ id });
                    wake.send();
                },
                cleanup() {
                    return Promise.resolve();
                },
            };

            yield* provide(outbox);
        } finally {
            disposing = true;
            reconciliationVersion += 1;
            const cleanupErrors: Error[] = [];
            const capture = (error: unknown) => {
                cleanupErrors.push(normalizeError(error));
            };

            lifetime.unsubscribeResults?.();
            lifetime.unsubscribeCollection?.unsubscribe();
            if (lifetime.server) {
                try {
                    yield* until(lifetime.server.close());
                } catch (error) {
                    capture(error);
                }
            }
            if (lifetime.leaderTask !== undefined) {
                try {
                    yield* lifetime.leaderTask.halt();
                } catch (error) {
                    capture(error);
                }
            }
            if (lifetime.leaderRun) {
                yield* until(Promise.allSettled([lifetime.leaderRun]));
            }
            if (lifetime.connectivityTask !== undefined) {
                try {
                    yield* lifetime.connectivityTask.halt();
                } catch (error) {
                    capture(error);
                }
            }
            try {
                yield* until(projections.close());
            } catch (error) {
                capture(error);
            }
            const disposed = new Error("Outbox disposed.");
            for (const completion of completions.values()) {
                completion.reject(disposed);
            }
            completions.clear();
            try {
                yield* until(collection.cleanup());
            } catch (error) {
                capture(error);
            }

            if (cleanupErrors[0]) {
                yield* until(Promise.reject(cleanupErrors[0]));
            }
        }
    });
}

export interface StartedOntologyOutbox extends OntologyOutbox {
    readonly task: Task<void>;
}

export function createOntologyOutbox(options: CreateOntologyOutboxOptions): StartedOntologyOutbox {
    const collection = createOutboxCollection(options);
    let outbox: OntologyOutbox | undefined;
    const ready = deferred<void>();
    const task = run(function* () {
        try {
            const value = yield* useOntologyOutbox(options, collection);
            outbox = value;
            ready.resolve();
            yield* suspend();
        } catch (error) {
            ready.reject(normalizeError(error));
            throw error;
        }
    });
    void task.catch(() => undefined);

    return {
        collection,
        ready: ready.promise,
        task,
        async enqueue(request, enqueueOptions) {
            await ready.promise;
            return outbox!.enqueue(request, enqueueOptions);
        },
        async edit(id, update) {
            await ready.promise;
            return outbox!.edit(id, update);
        },
        async remove(id) {
            await ready.promise;
            return outbox!.remove(id);
        },
        async retry(id) {
            await ready.promise;
            return outbox!.retry(id);
        },
        async cleanup() {
            await task.halt();
        },
    };
}
