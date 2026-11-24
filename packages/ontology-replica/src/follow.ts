import { BackendError } from "@party-stack/ontology-backend";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import {
    Deferred,
    Effect,
    Exit,
    Option,
    Result,
    Schedule,
    Scope,
    Semaphore,
    Stream,
    SubscriptionRef,
} from "effect";
import { kernel, upstream } from "./internal.js";
import type { ReplicaService as KernelService } from "./engine.js";
import type { ReplicaDefinition, ReplicaService } from "./service.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

const subsetType = (subset: unknown) => {
    const value = subset as
        | { objectType?: unknown; from?: { source?: { objectType?: unknown } } }
        | undefined;
    const type = value?.objectType ?? value?.from?.source?.objectType;
    return typeof type === "string" ? [type] : [];
};
/**
 * A backend that asks the definition source to look again when a request fails with
 * `SchemaMismatch`: the provider no longer knows something this definition references. If the
 * definition changed, the replica reopens under it; if not, the error stands. The request's
 * error is returned unchanged either way.
 */
export const revalidateOnMismatch = (
    backend: OntologyBackendService,
    revalidate: NonNullable<ReplicaDefinition["revalidate"]>
): OntologyBackendService => {
    const check =
        (objectTypes: readonly string[]) =>
        <A, R>(effect: Effect.Effect<A, BackendError, R>) =>
            Effect.tapError(effect, (error) =>
                error.kind === "SchemaMismatch"
                    ? Effect.forkDetach(
                          revalidate({ objectTypes }).pipe(
                              Effect.catch((failure) =>
                                  Effect.logWarning("Definition recheck failed", failure)
                              )
                          )
                      )
                    : Effect.void
            );
    return {
        ...backend,
        loadSubset: (subset) => check(subsetType(subset))(backend.loadSubset(subset)),
        query: (document, settings) => check([])(backend.query(document, settings)),
        applyAction: (request) => check([])(backend.applyAction(request)),
        queryFunction: (name, parameters) => check([])(backend.queryFunction(name, parameters)),
        ...(backend.validateAction && {
            validateAction: (name, parameters, settings) =>
                check([])(backend.validateAction!(name, parameters, settings)),
        }),
        ...(backend.resolveActionParameters && {
            resolveActionParameters: (name, parameters) =>
                check([])(backend.resolveActionParameters!(name, parameters)),
        }),
    };
};

/** One engine opened under one definition. Replaced, never mutated, when the definition changes. */
interface Generation {
    readonly ir: OntologyIR;
    readonly service: ReplicaService;
    readonly scope: Scope.Closeable;
    /** Resolved before the scope closes, so calls running on this generation move to the next. */
    readonly closing: Deferred.Deferred<void>;
    /** Writes hold one permit; closing takes them all, so a write is never cut off mid-way. */
    readonly writes: Semaphore.Semaphore;
    closed: boolean;
}
type State =
    | { readonly _tag: "opening" }
    | { readonly _tag: "open"; readonly generation: Generation }
    | { readonly _tag: "failed"; readonly error: BackendError };

const WRITE_PERMITS = 1 << 20;

const signature = (ir: OntologyIR) => {
    try {
        return ontologyDefinitionSignature(ir);
    } catch {
        // Definitions read from metadata may carry fields the signature's schema rejects;
        // compare those whole. Opening an unusable definition reports its own error.
        return JSON.stringify(ir);
    }
};

/**
 * A replica that follows its definition. Each definition opens an engine behind the same
 * handle; a new definition closes the engine and opens another, whose startup transaction
 * clears only what the change requires (`onDefinitionChange`). Reads and waits that were
 * running move to the new engine, writes finish before it closes, live queries switch to it,
 * and demand held across the change is acquired again.
 */
export const followReplicaDefinition = Effect.fnUntraced(function* (options: {
    readonly definition: ReplicaDefinition;
    readonly open: (ir: OntologyIR) => Effect.Effect<ReplicaService, BackendError, Scope.Scope>;
    /** Runs between closing the engine for `previous` and opening the one for `next`. */
    readonly changed?: (previous: OntologyIR, next: OntologyIR) => Effect.Effect<void>;
}): Effect.fn.Return<ReplicaService, BackendError, Scope.Scope> {
    const owner = yield* Effect.scope;
    const state = yield* SubscriptionRef.make<State>({ _tag: "opening" });
    let current: Generation | undefined;

    const close = Effect.fnUntraced(function* (generation: Generation) {
        yield* generation.writes.withPermits(WRITE_PERMITS)(
            Effect.sync(() => {
                generation.closed = true;
            })
        );
        yield* Deferred.succeed(generation.closing, undefined);
        yield* Scope.close(generation.scope, Exit.void);
    });
    const openGeneration = Effect.fnUntraced(function* (ir: OntologyIR) {
        const scope = yield* Scope.fork(owner);
        const opened = yield* Effect.exit(Scope.provide(options.open(ir), scope));
        if (Exit.isFailure(opened)) {
            yield* Scope.close(scope, opened);
            return yield* Effect.failCause(opened.cause);
        }
        return {
            ir,
            service: opened.value,
            scope,
            closing: yield* Deferred.make<void>(),
            writes: yield* Semaphore.make(WRITE_PERMITS),
            closed: false,
        } satisfies Generation;
    });
    const apply = Effect.fnUntraced(function* (ir: OntologyIR) {
        const previous = current;
        if (previous && signature(previous.ir) === signature(ir)) return;
        if (previous) {
            yield* SubscriptionRef.set(state, { _tag: "opening" });
            current = undefined;
            yield* close(previous);
            if (options.changed) yield* options.changed(previous.ir, ir);
        }
        const opened = yield* Effect.exit(openGeneration(ir));
        if (Exit.isSuccess(opened)) {
            current = opened.value;
            yield* SubscriptionRef.set(state, { _tag: "open", generation: opened.value });
            return;
        }
        const error = Exit.findErrorOption(opened).pipe(
            Option.getOrElse(
                () =>
                    new BackendError({
                        operation: "replica.definition",
                        kind: "Internal",
                        retryable: false,
                        message: "The replica could not open under its new definition.",
                    })
            )
        );
        yield* Effect.logWarning("Replica could not open under a new definition", error);
        // The failed startup transaction rolled back, so the cache still matches the previous
        // definition. Keep serving it until the source supplies one that opens.
        if (previous) {
            const restored = yield* Effect.exit(openGeneration(previous.ir));
            if (Exit.isSuccess(restored)) {
                current = restored.value;
                yield* SubscriptionRef.set(state, { _tag: "open", generation: restored.value });
                return;
            }
        }
        yield* SubscriptionRef.set(state, { _tag: "failed", error });
    });
    yield* Effect.addFinalizer(() => (current ? close(current) : Effect.void));

    const ready = SubscriptionRef.changes(state).pipe(
        Stream.filter((value) => value._tag !== "opening"),
        Stream.runHead,
        Effect.flatMap((value) => {
            const settled = Option.getOrUndefined(value);
            return settled?._tag === "open"
                ? Effect.succeed(settled.generation)
                : Effect.fail(
                      settled?._tag === "failed"
                          ? settled.error
                          : new BackendError({
                                operation: "replica.definition",
                                kind: "Unavailable",
                                retryable: true,
                                message: "The replica is closed.",
                            })
                  );
        })
    );
    // The definition source may fail transiently (a metadata request, a dropped connection).
    // The replica keeps its current definition and subscribes again.
    const first = yield* Deferred.make<void, BackendError>();
    yield* options.definition.changes.pipe(
        Stream.changesWith((left, right) => left === right),
        Stream.runForEach((ir) => Effect.andThen(apply(ir), Deferred.succeed(first, undefined))),
        Effect.andThen(
            Effect.fail(
                new BackendError({
                    operation: "replica.definition",
                    kind: "Unavailable",
                    retryable: true,
                    message: "The definition source ended.",
                })
            )
        ),
        Effect.tapError((error) =>
            Effect.andThen(
                Deferred.fail(first, error),
                Effect.logWarning("Replica definition source failed", error)
            )
        ),
        Effect.retry(Schedule.spaced("5 seconds")),
        Effect.forkIn(owner)
    );
    yield* Deferred.await(first);
    yield* ready;

    /** Reads and waits: if the engine closes first, run again on the next one. */
    const read = <A, E, R>(run: (service: ReplicaService) => Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
            while (true) {
                const generation = yield* ready;
                const result = yield* Effect.raceFirst(
                    Effect.map(run(generation.service), Option.some),
                    Effect.as(Deferred.await(generation.closing), Option.none<A>())
                );
                if (Option.isSome(result)) return result.value;
            }
        });
    /** Writes finish on the engine they started on; one that arrives while it closes waits for the next. */
    const write = <A, E, R>(run: (service: ReplicaService) => Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
            while (true) {
                const generation = yield* ready;
                const result = yield* generation.writes.withPermit(
                    Effect.suspend(() =>
                        generation.closed
                            ? Effect.succeed(Option.none<A>())
                            : Effect.map(run(generation.service), Option.some)
                    )
                );
                if (Option.isSome(result)) return result.value;
            }
        });
    /** Live streams switch to each new engine and emit from it. */
    const follow = <A>(
        run: (service: ReplicaService) => Stream.Stream<A, BackendError>
    ): Stream.Stream<A, BackendError> =>
        SubscriptionRef.changes(state).pipe(
            Stream.switchMap((value) =>
                value._tag === "open"
                    ? run(value.generation.service).pipe(
                          Stream.interruptWhen(Deferred.await(value.generation.closing)),
                          Stream.catch((error) =>
                              value.generation.closed ? Stream.empty : Stream.fail(error)
                          )
                      )
                    : value._tag === "failed"
                      ? Stream.fail(value.error)
                      : Stream.empty
            )
        );
    const generationValue =
        <A>(pick: (service: ReplicaService) => A) =>
        () =>
            pick(current!.service);

    const acquire: ReplicaService["demand"]["acquire"] = (subset, settings) =>
        Effect.gen(function* () {
            const caller = yield* Effect.scope;
            const holdOn = (generation: Generation, demand: typeof settings) =>
                Effect.gen(function* () {
                    // Forked from the engine's scope so its release runs before the engine closes.
                    const held = yield* Scope.fork(generation.scope);
                    yield* Scope.addFinalizer(caller, Scope.close(held, Exit.void));
                    yield* Scope.provide(generation.service.demand.acquire(subset, demand), held).pipe(
                        Effect.onError((cause) => Scope.close(held, Exit.failCause(cause)))
                    );
                });
            let held: Generation | undefined;
            while (!held) {
                const generation = yield* ready;
                const result = yield* Effect.raceFirst(
                    Effect.as(holdOn(generation, settings), Option.some(generation)),
                    Effect.as(Deferred.await(generation.closing), Option.none<Generation>())
                );
                held = Option.getOrUndefined(result);
            }
            const initial = held;
            // Later engines: hold the same demand again, without waiting for it to complete.
            yield* SubscriptionRef.changes(state).pipe(
                Stream.filterMap((value) =>
                    value._tag === "open" && value.generation !== initial
                        ? Result.succeed(value.generation)
                        : Result.fail(undefined)
                ),
                Stream.runForEach((generation) =>
                    holdOn(generation, settings?.localOnly ? settings : { resultType: "cached" }).pipe(
                        Effect.catch((error) =>
                            Effect.logWarning("Demand could not be held under the new definition", error)
                        )
                    )
                ),
                Effect.forkIn(caller)
            );
        });

    const handle: ReplicaService = {
        get ir() {
            return current!.ir;
        },
        get context() {
            return current!.service.context;
        },
        get sourceId() {
            return current!.service.sourceId;
        },
        get upstreamKind() {
            return current!.service.upstreamKind;
        },
        get network() {
            return current!.service.network;
        },
        get authentication() {
            return current!.service.authentication;
        },
        definition: {
            current: Effect.map(ready, (generation) => generation.ir),
            changes: SubscriptionRef.changes(state).pipe(
                Stream.filterMap((value) =>
                    value._tag === "open" ? Result.succeed(value.generation.ir) : Result.fail(undefined)
                ),
                Stream.changes
            ),
        },
        get: (type, key) => read((service) => service.get(type, key)),
        readSubset: (subset) => read((service) => service.readSubset(subset)),
        confirmed: {
            get: (type, key) => read((service) => service.confirmed.get(type, key)),
            readSubset: (subset) => read((service) => service.confirmed.readSubset(subset)),
        },
        decrypt: (value, settings) => read((service) => service.decrypt(value, settings)),
        attachments: {
            create: (input, settings) => write((service) => service.attachments.create(input, settings)),
            source: (value, settings) => read((service) => service.attachments.source(value, settings)),
            blob: (value) => read((service) => service.attachments.blob(value)),
            metadata: (value, settings) => read((service) => service.attachments.metadata(value, settings)),
        },
        queryFunction: (name, parameters) => read((service) => service.queryFunction(name, parameters)),
        actions: {
            resolveParameters: (name, parameters) =>
                read((service) => service.actions.resolveParameters(name, parameters)),
            validate: (name, parameters, settings) =>
                read((service) => service.actions.validate(name, parameters, settings)),
            apply: Effect.fn("Replica.applyAction")(function* (request, settings) {
                yield* handle.outbox.enqueue(request, { optimistic: settings?.optimistic });
                const receipt = yield* handle.outbox.wait(request.id);
                if (!receipt)
                    return yield* new BackendError({
                        operation: "applyAction",
                        kind: "ResultExpired",
                        message: "Action result is unavailable.",
                        retryable: false,
                        actionOutcome: "unknown",
                    });
                return receipt;
            }),
        },
        observeSubset: (subset) => follow((service) => service.observeSubset(subset)),
        demand: {
            acquire,
            pins: {
                backend: read((service) => service.demand.pins.backend),
                list: read((service) => service.demand.pins.list),
                changes: follow((service) => service.demand.pins.changes),
                set: (pin) => write((service) => service.demand.pins.set(pin)),
                remove: (id) => write((service) => service.demand.pins.remove(id)),
                update: (change) => write((service) => service.demand.pins.update(change)),
                clear: (name) => write((service) => service.demand.pins.clear(name)),
            },
        },
        outbox: {
            enqueue: (request, settings) => write((service) => service.outbox.enqueue(request, settings)),
            entries: read((service) => service.outbox.entries),
            observe: (ids) => follow((service) => service.outbox.observe(ids)),
            get: (id) => read((service) => service.outbox.get(id)),
            wait: (id, settings) => read((service) => service.outbox.wait(id, settings)),
            edit: (id, request) => write((service) => service.outbox.edit(id, request)),
            retry: (id, settings) => write((service) => service.outbox.retry(id, settings)),
            remove: (id, settings) => write((service) => service.outbox.remove(id, settings)),
        },
        status: {
            get: read((service) => service.status.get),
            changes: follow((service) => service.status.changes),
        },
        syncOnce: read((service) => service.syncOnce),
        revalidate: read((service) => service.revalidate),
        collectGarbage: (settings) => read((service) => service.collectGarbage(settings)),
    };
    // Server composition reads the engine of the current generation.
    Object.defineProperty(handle, kernel, {
        get: generationValue(
            (service) => (service as unknown as { readonly [kernel]: KernelService })[kernel]
        ),
    });
    Object.defineProperty(handle, upstream, {
        get: generationValue(
            (service) => (service as unknown as { readonly [upstream]?: unknown })[upstream]
        ),
    });
    return handle;
});
