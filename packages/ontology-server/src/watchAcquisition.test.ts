import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import { acquireRpcWatch } from "./rpcWatch.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
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
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
const owned = Effect.gen(function* () {
    return yield* makeOwnedBackend({
        ir,
        namespace: "watch-acquisition",
        tables: yield* Memory.make(),
        mutators: {},
    });
});
const connect = Effect.fnUntraced(function* (backend: OntologyBackendService) {
    const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
        Effect.provide(
            ontologyRpcHandlers({
                enableRealtime: true,
                backend,
                ir,
                authorize: () => Effect.void,
            })
        )
    );
    return yield* makeOntologyProtocolClient(client);
});

for (const kind of ["subset", "journal"] as const) {
    test(`RPC ${kind} acquisition waits for registration and retains events before consumption`, () =>
        Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const source = yield* owned;
                    const events = yield* PubSub.unbounded<void>();
                    const registered = yield* Deferred.make<void>();
                    const release = yield* Deferred.make<void>();
                    const closed = yield* Deferred.make<void>();
                    let active = 0;
                    const acquire = Effect.gen(function* () {
                        const subscription = yield* PubSub.subscribe(events);
                        active++;
                        yield* Effect.addFinalizer(() =>
                            Effect.sync(() => {
                                active--;
                            }).pipe(Effect.andThen(Deferred.succeed(closed, undefined)))
                        );
                        yield* Deferred.succeed(registered, undefined);
                        yield* Deferred.await(release);
                        return Stream.fromSubscription(subscription);
                    });
                    const connection = yield* connect({
                        ...source,
                        changes: kind === "journal" ? { ...source.changes!, watch: acquire } : undefined,
                        watchSubset: kind === "subset" ? () => acquire : undefined,
                    });
                    const scope = yield* Scope.fork(yield* Effect.scope);
                    const acquisition =
                        kind === "subset"
                            ? connection.backend.watchSubset!(objectSubset("Item"))!
                            : connection.backend.changes!.watch!;
                    const opening = yield* Scope.provide(acquisition, scope).pipe(Effect.forkScoped);
                    yield* Deferred.await(registered);
                    expect(opening.pollUnsafe()).toBeUndefined();
                    // The underlying subscription buffers even while its acquisition is
                    // still finishing, and stays registered after the ready wire frame.
                    yield* PubSub.publish(events, undefined);
                    yield* Deferred.succeed(release, undefined);
                    const stream = yield* Fiber.join(opening);
                    expect(active).toBe(1);
                    yield* PubSub.publish(events, undefined);
                    expect(yield* Stream.runCollect(stream.pipe(Stream.take(2)))).toEqual([
                        undefined,
                        undefined,
                    ]);
                    expect(active).toBe(1);
                    yield* Scope.close(scope, Exit.void);
                    yield* Deferred.await(closed);
                    expect(active).toBe(0);
                })
            )
        ));

    test(`cancelling RPC ${kind} acquisition releases an already registered upstream watch`, () =>
        Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const source = yield* owned;
                    const registered = yield* Deferred.make<void>();
                    const closed = yield* Deferred.make<void>();
                    const acquire = Effect.gen(function* () {
                        yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                        yield* Deferred.succeed(registered, undefined);
                        return yield* Effect.never;
                    });
                    const connection = yield* connect({
                        ...source,
                        changes: kind === "journal" ? { ...source.changes!, watch: acquire } : undefined,
                        watchSubset: kind === "subset" ? () => acquire : undefined,
                    });
                    const acquisition =
                        kind === "subset"
                            ? connection.backend.watchSubset!(objectSubset("Item"))!
                            : connection.backend.changes!.watch!;
                    const opening = yield* Effect.scoped(acquisition).pipe(Effect.forkScoped);
                    yield* Deferred.await(registered);
                    yield* Fiber.interrupt(opening);
                    yield* Deferred.await(closed);
                })
            )
        ));
}

test("RPC watch keeps trailing events in its readiness chunk and the subsequent failure", () =>
    Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const failure = new BackendError({
                    operation: "watch",
                    kind: "Unavailable",
                    retryable: true,
                    message: "Disconnected",
                });
                const stream = yield* acquireRpcWatch(
                    Stream.concat(Stream.make("reset", "invalidate"), Stream.fail(failure)),
                    "reset",
                    "test.watch"
                );
                const events: string[] = [];
                const result = yield* Effect.result(
                    Stream.runForEach(stream, (event) =>
                        Effect.sync(() => {
                            events.push(event);
                        })
                    )
                );
                expect(events).toEqual(["invalidate"]);
                expect(result).toMatchObject({ _tag: "Failure", failure });
            })
        )
    ));

test("RPC watch acquisition rejects EOF or the wrong readiness frame and releases its scope", () =>
    Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                for (const [stream, kind] of [
                    [Stream.empty, "Unavailable"],
                    [Stream.succeed("invalidate"), "InvalidResponse"],
                ] as const) {
                    let active = 0;
                    const result = yield* Effect.result(
                        acquireRpcWatch(
                            Stream.unwrap(
                                Effect.acquireRelease(
                                    Effect.sync(() => {
                                        active++;
                                        return stream;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            active--;
                                        })
                                )
                            ),
                            "reset",
                            "test.watch"
                        )
                    );
                    expect(result).toMatchObject({ _tag: "Failure", failure: { kind } });
                    expect(active).toBe(0);
                }
            })
        )
    ));

test("RPC acquisition rejects the provider's setup failure before advertising readiness", () =>
    Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const source = yield* owned;
                const failure = new BackendError({
                    operation: "setup",
                    kind: "RateLimited",
                    retryable: true,
                    retryAfterMs: 9000,
                    message: "Try later",
                });
                const connection = yield* connect({
                    ...source,
                    changes: undefined,
                    watchSubset: () => Effect.fail(failure),
                });
                const result = yield* Effect.result(connection.backend.watchSubset!(objectSubset("Item"))!);
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "RateLimited", retryAfterMs: 9000 },
                });
            })
        )
    ));
