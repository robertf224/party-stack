import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { projectOntologyBackend } from "./authorization.js";
import { policyWatches } from "./policyWatches.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    context: {
        type: o.struct({ fields: [{ name: "userId", displayName: "User", type: o.string({}) }] }),
        partition: [["userId"]],
    },
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "owner", displayName: "Owner", type: o.string({}) },
            ],
        },
        {
            name: "Form",
            displayName: "Form",
            pluralDisplayName: "Forms",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "projectId", displayName: "Project", type: o.string({}) },
            ],
        },
        {
            name: "Unused",
            displayName: "Unused",
            pluralDisplayName: "Unused",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
    policy: {
        objects: {
            select: [
                q.sub("projects", {
                    from: { source: { objectType: "Project" }, binding: "p" },
                    where: q.eq(q.field("p", "owner"), q.context("userId")),
                    select: [
                        q.selectField("id", q.field("p", "id")),
                        q.sub("forms", {
                            from: { source: { objectType: "Form" }, binding: "f" },
                            where: q.eq(q.field("f", "projectId"), q.field("p", "id")),
                            select: [q.selectField("id", q.field("f", "id"))],
                        }),
                    ],
                }),
            ],
        },
    },
};

test("a projected Form watch notices Project access changes and releases all dependency watches", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-watches",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* owned.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("Project", { id: "p", owner: "alice" });
                        yield* tx.put("Form", { id: "f", projectId: "p" });
                    })
                );
                const projectChanges = yield* PubSub.sliding<void>(1);
                const formChanges = yield* PubSub.sliding<void>(1);
                const ready = yield* Deferred.make<void>();
                const changed = yield* Deferred.make<void>();
                let active = 0;
                const requested: string[] = [];
                const view = yield* projectOntologyBackend({
                    ir,
                    context: { userId: "alice" },
                    backend: {
                        ...owned,
                        changes: undefined,
                        subscribeSelection: undefined,
                        watchSubset: (subset) => {
                            const type = subset.from.source.objectType;
                            requested.push(type);
                            expect(subset).toEqual(objectSubset(type));
                            return Effect.gen(function* () {
                                const subscription = yield* PubSub.subscribe(
                                    type === "Project" ? projectChanges : formChanges
                                );
                                active++;
                                yield* Effect.addFinalizer(() =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                                );
                                if (active === 2) yield* Deferred.succeed(ready, undefined);
                                return Stream.fromSubscription(subscription);
                            });
                        },
                    },
                });
                const forms = objectSubset("Form");
                expect((yield* view.backend.loadSubset(forms)).rows.map((row) => row.key)).toEqual(["f"]);
                const reader = yield* Stream.unwrap(view.backend.watchSubset!(forms)!).pipe(
                    Stream.scoped,
                    Stream.runForEach(() => Deferred.succeed(changed, undefined)),
                    Effect.forkScoped
                );
                yield* Deferred.await(ready).pipe(Effect.timeout("1 second"));
                expect(requested.sort((a, b) => a.localeCompare(b))).toEqual(["Form", "Project"]);
                yield* owned.storage.transaction((tx) => tx.put("Project", { id: "p", owner: "bob" }));
                // Only the policy ancestor changed; no Form event is sent.
                yield* PubSub.publish(projectChanges, undefined);
                yield* Deferred.await(changed).pipe(Effect.timeout("1 second"));
                expect((yield* view.backend.loadSubset(forms)).rows).toEqual([]);
                yield* Fiber.interrupt(reader);
                expect(active).toBe(0);
            })
        )
    );
});

test("a global journal hint is sufficient and missing dependency watches use provider polling", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-watch-fallback",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const specific = vi.fn(() => Effect.succeed(Stream.never));
                const all = Effect.succeed(Stream.never);
                const global = policyWatches(
                    { ...owned, watchSubset: specific, changes: { ...owned.changes!, watch: all } },
                    ir
                );
                expect(global.watch(objectSubset("Form"))).toBe(all);
                expect(specific).not.toHaveBeenCalled();
                const partial = policyWatches(
                    {
                        ...owned,
                        changes: undefined,
                        watchSubset: (subset) =>
                            subset.from.source.objectType === "Form"
                                ? Effect.succeed(Stream.never)
                                : undefined,
                        refresh: (subset) => ({
                            pollIntervalMs: subset.from.source.objectType === "Project" ? 60_000 : false,
                        }),
                    },
                    ir
                );
                expect(partial.watch(objectSubset("Form"))).toBeUndefined();
                expect(partial.refresh(objectSubset("Form"))).toEqual({ pollIntervalMs: 60_000 });
            })
        )
    );
});

test("lookup predicates conservatively watch all local target types", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-watch-lookup",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const definition: OntologyIR = {
                    ...ir,
                    context: {
                        type: o.struct({
                            fields: [
                                { name: "userId", displayName: "User", type: o.string({}) },
                                {
                                    name: "project",
                                    displayName: "Project",
                                    type: o.objectReference({ objectType: "Project" }),
                                },
                            ],
                        }),
                    },
                    policy: {
                        objects: {
                            select: [
                                q.sub("forms", {
                                    from: { source: { objectType: "Form" }, binding: "f" },
                                    where: q.eq(
                                        o.Expression.getAt({
                                            source: q.lookup(q.context("project")),
                                            path: ["owner"],
                                        }),
                                        q.context("userId")
                                    ),
                                    select: [q.selectField("id", q.field("f", "id"))],
                                }),
                            ],
                        },
                    },
                };
                expect(q.validatePolicy(definition)).toEqual([]);
                const watched: string[] = [];
                policyWatches(
                    {
                        ...owned,
                        changes: undefined,
                        watchSubset: (subset) => {
                            watched.push(subset.from.source.objectType);
                            return Effect.succeed(Stream.never);
                        },
                    },
                    definition
                ).watch(objectSubset("Form"));
                expect(watched.sort((a, b) => a.localeCompare(b))).toEqual(["Form", "Project", "Unused"]);
            })
        )
    );
});

test("related expression dependencies include both ends of the referenced link", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-watch-related",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const definition: OntologyIR = {
                    ...ir,
                    linkTypes: [
                        {
                            id: "formProject",
                            source: { objectType: "Form", name: "forms", displayName: "Forms" },
                            target: { objectType: "Project", name: "project", displayName: "Project" },
                            foreignKey: "projectId",
                            cardinality: "many",
                        },
                    ],
                    policy: {
                        objects: {
                            select: [
                                q.sub("forms", {
                                    from: { source: { objectType: "Form" }, binding: "f" },
                                    where: q.eq(
                                        o.Expression.getAt({
                                            source: o.Expression.related({
                                                source: q.local("f"),
                                                link: "project",
                                            }),
                                            path: ["owner"],
                                        }),
                                        q.context("userId")
                                    ),
                                    select: [q.selectField("id", q.field("f", "id"))],
                                }),
                            ],
                        },
                    },
                };
                expect(q.validatePolicy(definition)).toEqual([]);
                const watched: string[] = [];
                policyWatches(
                    {
                        ...owned,
                        changes: undefined,
                        watchSubset: (subset) => {
                            watched.push(subset.from.source.objectType);
                            return Effect.succeed(Stream.never);
                        },
                    },
                    definition
                ).watch(objectSubset("Form"));
                expect(watched.sort((a, b) => a.localeCompare(b))).toEqual(["Form", "Project"]);
            })
        )
    );
});

test("policy watch readiness waits for every dependency and preserves early dependency notifications", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-all-ready",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const changes = yield* PubSub.unbounded<void>();
                const projectRegistered = yield* Deferred.make<void>();
                const formRegistered = yield* Deferred.make<void>();
                const releaseProject = yield* Deferred.make<void>();
                let active = 0;
                const acquisition = policyWatches(
                    {
                        ...owned,
                        changes: undefined,
                        watchSubset: (subset) =>
                            Effect.gen(function* () {
                                const subscription = yield* PubSub.subscribe(changes);
                                active++;
                                yield* Effect.addFinalizer(() =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                                );
                                if (subset.from.source.objectType === "Project") {
                                    yield* Deferred.succeed(projectRegistered, undefined);
                                    yield* Deferred.await(releaseProject);
                                } else yield* Deferred.succeed(formRegistered, undefined);
                                return Stream.fromSubscription(subscription);
                            }),
                    },
                    ir
                ).watch(objectSubset("Form"))!;
                const scope = yield* Scope.fork(yield* Effect.scope);
                const opening = yield* Scope.provide(acquisition, scope).pipe(Effect.forkScoped);
                yield* Deferred.await(projectRegistered);
                yield* Deferred.await(formRegistered);
                yield* PubSub.publish(changes, undefined);
                // One dependency's first event cannot stand in for all subscriptions.
                expect(opening.pollUnsafe()).toBeUndefined();
                yield* Deferred.succeed(releaseProject, undefined);
                const stream = yield* Fiber.join(opening);
                expect(active).toBe(2);
                expect(yield* Stream.runCollect(stream.pipe(Stream.take(2)))).toEqual([undefined, undefined]);
                yield* Scope.close(scope, Exit.void);
                expect(active).toBe(0);
            })
        )
    );
});

test("cancelling policy acquisition releases dependencies which became ready first", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-cancel-ready",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const projectRegistered = yield* Deferred.make<void>();
                const formRegistered = yield* Deferred.make<void>();
                let active = 0;
                const acquisition = policyWatches(
                    {
                        ...owned,
                        changes: undefined,
                        watchSubset: (subset) =>
                            Effect.gen(function* () {
                                active++;
                                yield* Effect.addFinalizer(() =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                                );
                                if (subset.from.source.objectType === "Project") {
                                    yield* Deferred.succeed(projectRegistered, undefined);
                                    return yield* Effect.never;
                                }
                                yield* Deferred.succeed(formRegistered, undefined);
                                return Stream.never;
                            }),
                    },
                    ir
                ).watch(objectSubset("Form"))!;
                const opening = yield* Effect.scoped(acquisition).pipe(Effect.forkScoped);
                yield* Deferred.await(projectRegistered);
                yield* Deferred.await(formRegistered);
                expect(active).toBe(2);
                yield* Fiber.interrupt(opening);
                expect(active).toBe(0);
            })
        )
    );
});

test("a projected watch validates its initial read only after every policy dependency is subscribed", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "policy-read-after-ready",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const fastRegistered = yield* Deferred.make<void>();
                const slowRegistered = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const updates = yield* PubSub.unbounded<void>();
                const ready = new Set<string>();
                let reads = 0;
                const backend = makeOntologyBackend({
                    ir,
                    name: "policy-read-after-ready",
                    sourceId: owned.sourceId,
                    supportsIdempotency: false,
                    applyAction: owned.applyAction,
                    queryFunction: owned.queryFunction,
                    loadSubset: (subset) =>
                        Effect.gen(function* () {
                            expect([...ready].sort()).toEqual(["Form", "Project"]);
                            reads++;
                            return yield* owned.loadSubset(subset);
                        }),
                    watchSubset: (subset) =>
                        Effect.gen(function* () {
                            const type = subset.from.source.objectType;
                            const subscription = yield* PubSub.subscribe(updates);
                            if (type === "Project") {
                                yield* Deferred.succeed(slowRegistered, undefined);
                                yield* Deferred.await(release);
                            } else yield* Deferred.succeed(fastRegistered, undefined);
                            ready.add(type);
                            return Stream.fromSubscription(subscription);
                        }),
                });
                const projected = yield* projectOntologyBackend({
                    ir,
                    backend,
                    context: { userId: "alice" },
                });
                const opening = yield* projected.backend.watchSubset!(objectSubset("Form"))!.pipe(
                    Effect.forkScoped
                );
                yield* Deferred.await(fastRegistered);
                yield* Deferred.await(slowRegistered);
                expect(reads).toBe(0);
                yield* PubSub.publish(updates, undefined);
                yield* Deferred.succeed(release, undefined);
                const stream = yield* Fiber.join(opening);
                expect(reads).toBeGreaterThan(0);
                expect(yield* Stream.runCollect(stream.pipe(Stream.take(2)))).toEqual([undefined, undefined]);
            })
        )
    );
});

test.each(["dependency", "preflight"] as const)(
    "a failed projected watch %s releases partial leases before retrying in the same caller scope",
    async (phase) => {
        let active = 0;
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* makeOwnedBackend({
                        namespace: `policy-failed-${phase}`,
                        ir,
                        tables: yield* Memory.make(),
                        mutators: {},
                    });
                    yield* owned.storage.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* tx.put("Project", { id: "p", owner: "alice" });
                            yield* tx.put("Form", { id: "f", projectId: "p" });
                        })
                    );
                    const updates = yield* PubSub.unbounded<void>();
                    const formReady = yield* Deferred.make<void>();
                    let failing = true;
                    let preflightReads = 0;
                    const backend = makeOntologyBackend({
                        ir,
                        name: "failed-policy-acquisition",
                        sourceId: owned.sourceId,
                        supportsIdempotency: false,
                        applyAction: owned.applyAction,
                        queryFunction: owned.queryFunction,
                        loadSubset: (subset) =>
                            Effect.gen(function* () {
                                preflightReads++;
                                expect(active).toBe(2);
                                if (failing && phase === "preflight")
                                    return yield* new BackendError({
                                        operation: "policy.preflight",
                                        kind: "Forbidden",
                                        retryable: false,
                                        message: "Private provider failure",
                                    });
                                return yield* owned.loadSubset(subset);
                            }),
                        watchSubset: (subset) =>
                            Effect.gen(function* () {
                                const subscription = yield* PubSub.subscribe(updates);
                                active++;
                                yield* Effect.addFinalizer(() =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                                );
                                if (subset.from.source.objectType === "Form")
                                    yield* Deferred.succeed(formReady, undefined);
                                else {
                                    yield* Deferred.await(formReady);
                                    if (failing && phase === "dependency")
                                        return yield* new BackendError({
                                            operation: "policy.subscribe",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Dependency unavailable",
                                        });
                                }
                                return Stream.fromSubscription(subscription);
                            }),
                    });
                    const projected = yield* projectOntologyBackend({
                        ir,
                        backend,
                        context: { userId: "alice" },
                    });
                    const attempt = projected.backend.watchSubset!(objectSubset("Form"))!;
                    const result = yield* Effect.result(attempt);
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: phase === "dependency" ? "Unavailable" : "NotFound" },
                    });
                    // The outer scope remains open. Failure must close only this attempt,
                    // rather than retain its subscriptions until the entire caller exits.
                    expect(active).toBe(0);
                    expect(preflightReads > 0).toBe(phase === "preflight");
                    failing = false;
                    const stream = yield* attempt;
                    expect(active).toBe(2);
                    yield* PubSub.publish(updates, undefined);
                    expect(yield* Stream.runCollect(stream.pipe(Stream.take(2)))).toEqual([
                        undefined,
                        undefined,
                    ]);
                    expect(active).toBe(2);
                })
            )
        );
        expect(active).toBe(0);
    }
);
