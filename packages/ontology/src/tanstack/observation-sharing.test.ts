import { IR, whenSyncAccepted, type LoadSubsetOptions } from "@tanstack/db";
import { Deferred, Effect, Queue, Scheduler, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { replicatedCollectionOptions, scopedCollection } from "./collections.js";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

const fences = vi.hoisted(() => ({
    revisions: new WeakMap<object, number>(),
    reads: new WeakMap<object, number>(),
}));
vi.mock("@party-stack/ontology-replica/infrastructure", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@party-stack/ontology-replica/infrastructure")>();
    const { Effect } = await import("effect");
    return {
        ...actual,
        readVisibleRevision: (replica: ReplicaService) =>
            fences.revisions.has(replica)
                ? Effect.sync(() => {
                      fences.reads.set(replica, (fences.reads.get(replica) ?? 0) + 1);
                      return fences.revisions.get(replica)!;
                  })
                : undefined,
    };
});

type Row = { id: string; rank: number; value: string };
type Batch = {
    revision: number;
    reset: boolean;
    rows: readonly { key: string; value: Row }[];
    removed: readonly string[];
};
type Observer = {
    subset: ObjectSubset;
    queue: Queue.Enqueue<Batch>;
    closed: boolean;
    delivered: number;
};
const ir: ReplicaService["ir"] = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: { kind: "string", value: {} } },
                { name: "rank", displayName: "Rank", type: { kind: "integer", value: {} } },
                { name: "value", displayName: "Value", type: { kind: "string", value: {} } },
            ],
        },
    ],
};
const snapshot = (revision: number, ...rows: Row[]): Batch => ({
    revision,
    reset: true,
    rows: rows.map((value) => ({ key: value.id, value })),
    removed: [],
});
const where = (name: string, field: string, value: unknown): LoadSubsetOptions => ({
    where: new IR.Func(name, [new IR.PropRef([field]), new IR.Value(value)]),
});
const point = (id: string) => where("eq", "id", id);
const row = (id: string, value: string, rank = 1): Row => ({ id, value, rank });

const fixture = Effect.fnUntraced(function* (
    options: {
        native?: boolean;
        initial?: (subset: ObjectSubset, index: number) => Batch | undefined;
        acquire?: (subset: ObjectSubset, index: number) => Effect.Effect<void>;
        observerOpened?: (observer: Observer, index: number) => void;
    } = {}
) {
    const observers: Observer[] = [];
    const acquisitions: { subset: ObjectSubset; released: boolean }[] = [];
    let onCommit: (() => void) | undefined;
    let holdCommit: (() => Promise<void> | undefined) | undefined;
    let commits = 0;
    const replica = {
        ir,
        readSubset: () => Effect.succeed([]),
        demand: {
            acquire: (subset: ObjectSubset) =>
                Effect.gen(function* () {
                    const index = acquisitions.length;
                    yield* Effect.acquireRelease(
                        Effect.sync(() => {
                            const acquisition = { subset, released: false };
                            acquisitions.push(acquisition);
                            return acquisition;
                        }),
                        (acquisition) =>
                            Effect.sync(() => {
                                acquisition.released = true;
                            })
                    );
                    if (options.acquire) yield* options.acquire(subset, index);
                }),
        },
        observeSubset: (subset: ObjectSubset) =>
            Stream.unwrap(
                Effect.gen(function* () {
                    const queue = yield* Queue.unbounded<Batch>();
                    const index = observers.length;
                    const observer = yield* Effect.acquireRelease(
                        Effect.sync(() => {
                            const observer: Observer = { subset, queue, closed: false, delivered: 0 };
                            observers.push(observer);
                            options.observerOpened?.(observer, index);
                            return observer;
                        }),
                        (observer) =>
                            Effect.sync(() => {
                                observer.closed = true;
                            }).pipe(Effect.andThen(Queue.shutdown(queue)))
                    );
                    const initial = options.initial?.(subset, index);
                    return Stream.concat(
                        initial ? Stream.make(initial) : Stream.empty,
                        Stream.fromQueue(queue)
                    ).pipe(
                        Stream.tap(() =>
                            Effect.sync(() => {
                                observer.delivered++;
                            })
                        )
                    );
                })
            ),
    } as unknown as ReplicaService;
    if (options.native !== false) fences.revisions.set(replica, 0);
    const config = yield* replicatedCollectionOptions<Row>({
        id: "revisioned-native-observations",
        objectType: "Item",
        replica,
        getKey: (value) => value.id,
    });
    const sync = config.sync.sync;
    const source = yield* scopedCollection({
        ...config,
        sync: {
            ...config.sync,
            sync: (methods) =>
                sync({
                    ...methods,
                    commit: () => {
                        commits++;
                        const receipt = methods.commit();
                        onCommit?.();
                        const held = holdCommit?.();
                        return held ? Promise.resolve(whenSyncAccepted(receipt)).then(() => held) : receipt;
                    },
                }),
        },
    });
    const lease = source.subscribeChanges(() => {});
    yield* Effect.addFinalizer(() => Effect.sync(() => lease.unsubscribe()));
    return {
        source,
        observers,
        acquisitions,
        commits: () => commits,
        revision: (value: number) => fences.revisions.set(replica, value),
        fenceReads: () => fences.reads.get(replica) ?? 0,
        load: (subset: LoadSubsetOptions) => source._sync.loadSubset(subset),
        unload: (subset: LoadSubsetOptions) => source._sync.unloadSubset(subset),
        publish: (observer: Observer, batch: Batch) => Queue.offerUnsafe(observer.queue, batch),
        onCommit: (callback: () => void) => {
            onCommit = callback;
        },
        holdCommit: (callback: () => Promise<void> | undefined) => {
            holdCommit = callback;
        },
    };
});

test("a custom replica without the native revision capability keeps independent observations", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture({ native: false, initial: () => snapshot(0, row("one", "Custom")) });
                const first = where("gte", "rank", 0),
                    second = where("gte", "rank", 0);
                yield* Effect.promise(async () => {
                    await f.load(first);
                    await f.load(second);
                });
                expect(f.observers).toHaveLength(2);
                expect(f.acquisitions).toHaveLength(2);
                expect(f.fenceReads()).toBe(0);
                f.unload(first);
                yield* Effect.promise(() => vi.waitFor(() => expect(f.observers[0]!.closed).toBe(true)));
                expect(f.observers[1]!.closed).toBe(false);
                expect(f.source.get("one")?.value).toBe("Custom");
            })
        )
    );
});

test("equivalent native regions share one observer while every caller retains its own cancellable demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture({ initial: () => snapshot(0, row("one", "Initial")) });
                const controller = new AbortController();
                const first = { ...where("gte", "rank", 0), signal: controller.signal };
                const second = where("gte", "rank", 0);
                yield* Effect.promise(async () => {
                    await f.load(first);
                    await f.load(second);
                });
                expect(f.observers).toHaveLength(1);
                expect(f.acquisitions).toHaveLength(2);
                controller.abort();
                yield* Effect.promise(() => vi.waitFor(() => expect(f.acquisitions[0]!.released).toBe(true)));
                expect(f.acquisitions[1]!.released).toBe(false);
                expect(f.observers[0]!.closed).toBe(false);
                f.revision(1);
                f.publish(f.observers[0]!, snapshot(1, row("one", "Sibling remains live")));
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(f.source.get("one")?.value).toBe("Sibling remains live"))
                );
                f.unload(second);
                yield* Effect.promise(() =>
                    vi.waitFor(() => {
                        expect(f.acquisitions.every((acquisition) => acquisition.released)).toBe(true);
                        expect(f.observers[0]!.closed).toBe(true);
                    })
                );
            })
        )
    );
});

test("a late X after newer overlapping Y cannot contribute or settle until the shared X reaches its fence", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture({
                    initial: (_subset, index) =>
                        index === 0
                            ? snapshot(1, row("shared", "Old"), row("x-only", "Old membership", 20))
                            : snapshot(2, row("shared", "New"), row("y-only", "Y", -1)),
                });
                const firstX = where("gte", "rank", 0);
                f.revision(1);
                yield* Effect.promise(async () => {
                    await f.load(firstX);
                });
                const y = where("lte", "rank", 10);
                f.revision(2);
                yield* Effect.promise(async () => {
                    await f.load(y);
                });
                expect(f.source.get("shared")?.value).toBe("New");
                const lateX = where("gte", "rank", 0);
                let ready = false;
                const pending = Promise.resolve(f.load(lateX)).then(() => {
                    ready = true;
                });
                void pending.catch(() => undefined);
                yield* Effect.promise(() => vi.waitFor(() => expect(f.fenceReads()).toBe(3)));
                yield* Effect.yieldNow;
                expect(ready).toBe(false);
                expect(f.observers).toHaveLength(2);
                expect(f.acquisitions).toHaveLength(3);
                expect(f.source.get("shared")?.value).toBe("New");
                f.publish(
                    f.observers[0]!,
                    snapshot(2, row("shared", "Current X"), row("new-x", "Inserted", 30))
                );
                yield* Effect.promise(() => pending);
                expect(f.source.get("shared")?.value).toBe("Current X");
                expect(f.source.has("x-only")).toBe(false);
                expect(f.source.has("new-x")).toBe(true);
                f.unload(y);
                yield* Effect.promise(() =>
                    vi.waitFor(() => {
                        expect(f.source.has("y-only")).toBe(false);
                        expect(f.source.get("shared")?.value).toBe("Current X");
                    })
                );
                f.revision(3);
                f.publish(f.observers[0]!, { revision: 3, reset: false, rows: [], removed: ["new-x"] });
                yield* Effect.promise(() => vi.waitFor(() => expect(f.source.has("new-x")).toBe(false)));
            })
        )
    );
});

test("releasing the final member discards its observation incarnation before reacquiring the same region", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture({
                    initial: (_subset, index) => snapshot(index, row("one", `Session ${index}`)),
                });
                const first = where("gte", "rank", 0);
                yield* Effect.promise(async () => {
                    await f.load(first);
                });
                const old = f.observers[0]!;
                f.unload(first);
                yield* Effect.promise(() => vi.waitFor(() => expect(old.closed).toBe(true)));
                f.revision(1);
                const next = where("gte", "rank", 0);
                yield* Effect.promise(async () => {
                    await f.load(next);
                });
                expect(f.observers).toHaveLength(2);
                expect(f.source.get("one")?.value).toBe("Session 1");
                f.publish(old, snapshot(100, row("one", "Old stream must be ignored")));
                yield* Effect.yieldNow;
                expect(f.source.get("one")?.value).toBe("Session 1");
                expect(f.acquisitions[0]!.released).toBe(true);
                expect(f.acquisitions[1]!.released).toBe(false);
            })
        )
    );
});

test("an observed empty point still waits for its own upstream acquisition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const gate = yield* Deferred.make<void>();
                const f = yield* fixture({ initial: () => snapshot(0), acquire: () => Deferred.await(gate) });
                const first = point("missing"),
                    second = point("missing");
                let completed = 0;
                const one = Promise.resolve(f.load(first)).then(() => {
                    completed++;
                });
                const two = Promise.resolve(f.load(second)).then(() => {
                    completed++;
                });
                void one.catch(() => undefined);
                void two.catch(() => undefined);
                yield* Effect.promise(() => vi.waitFor(() => expect(f.acquisitions).toHaveLength(2)));
                yield* Effect.yieldNow;
                expect(f.observers).toHaveLength(1);
                expect(completed).toBe(0);
                yield* Deferred.succeed(gate, undefined);
                yield* Effect.promise(() => Promise.all([one, two]));
                expect(completed).toBe(2);
                expect(f.source.size).toBe(0);
            })
        )
    );
});

test("a synchronous positive point remains usable while each upstream lease is still acquiring", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const gate = yield* Deferred.make<void>();
                yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
                const f = yield* fixture({
                    initial: () => snapshot(0, row("one", "Ready locally")),
                    acquire: () => Deferred.await(gate),
                });
                expect(f.load(point("one"))).toBe(true);
                expect(f.load(point("one"))).toBe(true);
                expect(f.observers).toHaveLength(1);
                expect(f.acquisitions).toHaveLength(2);
                expect(f.source.get("one")?.value).toBe("Ready locally");
            })
        )
    );
});

test("cached complete absence cannot bypass a newly joined caller's local revision fence", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture({ initial: () => snapshot(0) });
                yield* Effect.promise(async () => {
                    await f.load(where("gte", "rank", 0));
                });
                f.revision(1);
                let ready = false;
                const pending = Promise.resolve(f.load(where("gte", "rank", 0))).then(() => {
                    ready = true;
                });
                void pending.catch(() => undefined);
                yield* Effect.promise(() => vi.waitFor(() => expect(f.fenceReads()).toBe(2)));
                yield* Effect.yieldNow;
                expect(ready).toBe(false);
                f.publish(f.observers[0]!, snapshot(1));
                yield* Effect.promise(() => pending);
                expect(f.observers).toHaveLength(1);
                expect(f.source.size).toBe(0);
            })
        )
    );
});

test("an equivalent demand acquired reentrantly during a held first commit shares the graph without settling early", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let release!: () => void;
                const held = new Promise<void>((resolve) => {
                    release = resolve;
                });
                yield* Effect.addFinalizer(() => Effect.sync(release));
                const f = yield* fixture({ initial: () => snapshot(0, row("one", "Initial")) });
                let firstCommit = true;
                f.holdCommit(() => {
                    if (!firstCommit) return;
                    firstCommit = false;
                    return held;
                });
                let nested: Promise<void> | undefined;
                let nestedReady = false;
                f.onCommit(() => {
                    if (nested) return;
                    nested = Promise.resolve(f.load(where("gte", "rank", 0))).then(() => {
                        nestedReady = true;
                    });
                    void nested.catch(() => undefined);
                });
                const first = Promise.resolve(f.load(where("gte", "rank", 0)));
                void first.catch(() => undefined);
                yield* Effect.promise(() =>
                    vi.waitFor(() => {
                        expect(f.observers).toHaveLength(1);
                        expect(f.acquisitions).toHaveLength(2);
                    })
                );
                expect(nestedReady).toBe(false);
                expect(f.source.get("one")?.value).toBe("Initial");
                release();
                yield* Effect.promise(() => Promise.all([first, nested]));
                expect(nestedReady).toBe(true);
                expect(f.commits()).toBe(1);
            })
        )
    );
});

test("cooperative yields cannot create competing observation owners for concurrent equivalent loads", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture({ initial: () => snapshot(0, row("one", "Shared")) });
                const subsets = Array.from({ length: 8 }, () => where("gte", "rank", 0));
                yield* Effect.promise(() =>
                    Promise.all(subsets.map((subset) => Promise.resolve(f.load(subset))))
                );
                expect(f.observers).toHaveLength(1);
                expect(f.acquisitions).toHaveLength(subsets.length);
                expect(f.fenceReads()).toBe(subsets.length);
                for (const subset of subsets.slice(0, -1)) f.unload(subset);
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(f.acquisitions.filter((entry) => entry.released)).toHaveLength(
                            subsets.length - 1
                        )
                    )
                );
                expect(f.observers[0]!.closed).toBe(false);
                f.revision(1);
                f.publish(f.observers[0]!, snapshot(1, row("one", "Still shared")));
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(f.source.get("one")?.value).toBe("Still shared"))
                );
                f.unload(subsets.at(-1)!);
                yield* Effect.promise(() => vi.waitFor(() => expect(f.observers[0]!.closed).toBe(true)));
            })
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 10))
    );
});

test("cancelling the creating caller during observer startup cannot strand a surviving caller", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const controller = new AbortController();
                const f = yield* fixture({
                    initial: () => snapshot(0, row("one", "Initial")),
                    observerOpened: (_observer, index) => {
                        if (index === 0) controller.abort();
                    },
                });
                const first = Promise.resolve(
                    f.load({ ...where("gte", "rank", 0), signal: controller.signal })
                );
                void first.catch(() => undefined);
                const second = where("gte", "rank", 0);
                yield* Effect.promise(async () => {
                    await f.load(second);
                    await Promise.allSettled([first]);
                });
                expect(controller.signal.aborted).toBe(true);
                expect(f.acquisitions).toHaveLength(2);
                yield* Effect.promise(() => vi.waitFor(() => expect(f.acquisitions[0]!.released).toBe(true)));
                expect(f.acquisitions[1]!.released).toBe(false);
                const live = f.observers.filter((observer) => !observer.closed);
                expect(live).toHaveLength(1);
                f.revision(1);
                f.publish(live[0]!, snapshot(1, row("one", "Survivor")));
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(f.source.get("one")?.value).toBe("Survivor"))
                );
                f.unload(second);
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(f.observers.every((observer) => observer.closed)).toBe(true))
                );
            })
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 10))
    );
});
