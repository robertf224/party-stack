import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import * as BrowserIndexedDb from "@effect/platform-browser/IndexedDb";
import * as IndexedDb from "@party-stack/indexeddb-ontology-storage/tables";
import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { createTraceCapture } from "@party-stack/runtime/tracing";
import { Cause, Effect, Exit, Fiber, Scope, Tracer } from "effect";
import { makeReplicaKernel } from "../../ontology-replica/lib/engine.js";
import { replicaStateSource } from "../../ontology-replica/lib/parent.js";
import { execute, ir, count, subsets, targetId } from "./query-path-fixture.js";

const control = await new Promise<MessagePort>((resolve) => {
    (globalThis as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (event) =>
        resolve(event.ports[0]!);
});
control.start();
const rpcPort = await new Promise<MessagePort>((resolve) => {
    control.onmessage = (event) => resolve(event.ports[0]!);
});
const scope = new URL(location.href).searchParams.get("scope")!;
const trace = createTraceCapture();
const reads: { rows: number; complete: boolean; durationMs: number }[] = [];
const owner = Scope.makeUnsafe();
Effect.runFork(
    Scope.provide(
        Effect.gen(function* () {
            const setupAt = performance.now();
            const authority = yield* makeOwnedBackend({
                namespace: "query-path-authority",
                ir,
                tables: yield* Memory.make(),
                mutators: { seed: execute, edit: execute },
            });
            yield* authority.applyAction({ id: "seed", name: "seed", parameters: {} });
            const tables = yield* IndexedDb.make({ databaseName: `party-query-path:${scope}` });
            const parent = yield* makeReplicaKernel({
                namespace: "query-path-parent",
                ir,
                tables,
                backend: authority,
                execute,
                startSync: false,
                objectCacheGc: false,
            });
            yield* parent.demand({ objectType: "Note" });
            yield* parent.syncOnce;
            // Charge index construction and readiness to shared setup, rather
            // than to only the delivery arm of the matched read comparison.
            for (const subset of subsets) yield* parent.demand(subset);
            yield* parent.syncOnce;
            const proof = yield* parent.snapshotSubset({ objectType: "Note" }, false);
            if (!proof.complete || proof.rows.length !== count) throw new Error("Parent cache is not ready.");
            // Test-only finite READ facet over this SAME composed worker replica. It is
            // never used as a child's committed backend or as a write/acceptance channel.
            const visibleReader = makeOntologyBackend({
                ir,
                name: "benchmark-visible-read-only",
                sourceId: parent.sourceId,
                supportsIdempotency: false,
                loadSubset: (request) =>
                    Effect.gen(function* () {
                        const subset = yield* compileObjectSubset(ir, request);
                        const began = performance.now();
                        const snapshot = yield* parent.snapshotSubset(subset, false);
                        reads.push({
                            rows: snapshot.rows.length,
                            complete: snapshot.complete,
                            durationMs: performance.now() - began,
                        });
                        return snapshot;
                    }),
                watchSubset: () => parent.subscribeChanges,
                applyAction: () =>
                    Effect.fail(
                        new BackendError({
                            operation: "benchmark",
                            kind: "NotImplemented",
                            retryable: false,
                            message:
                                "The read baseline cannot submit writes; use the real source Accept capability.",
                        })
                    ),
                queryFunction: () =>
                    Effect.fail(
                        new BackendError({
                            operation: "benchmark",
                            kind: "NotImplemented",
                            retryable: false,
                            message: "No benchmark query function.",
                        })
                    ),
            });
            const server = yield* serveOntologyWorker({
                enableRealtime: true,
                source: replicaStateSource(parent),
                backend: visibleReader,
                ir,
                authorize: () => Effect.void,
            }).pipe(Effect.provide(BrowserWorkerRunner.layerMessagePort(rpcPort)));
            control.onmessage = (event) => {
                const { id, command } = event.data as { id: string; command: string };
                const work: Effect.Effect<unknown, unknown, Scope.Scope> =
                    command === "metrics"
                        ? Effect.sync(() => {
                              const spans = trace
                                  .getSnapshot()
                                  .filter((span) =>
                                      [
                                          "Delivery.prepare",
                                          "Delivery.capture",
                                          "IndexedDB.transaction",
                                      ].includes(span.name)
                                  );
                              trace.clear();
                              return { reads: reads.splice(0), spans };
                          })
                        : command === "summary"
                          ? Effect.gen(function* () {
                                const committed = yield* authority.loadSubset(
                                    objectSubset("Note", {
                                        where: {
                                            op: "eq",
                                            left: { _tag: "Field", path: ["id"] },
                                            right: targetId,
                                        },
                                    })
                                );
                                return {
                                    pending: (yield* parent.pending).map((entry) => ({
                                        id: entry.invocation.id,
                                        state: entry.state,
                                    })),
                                    authoritative: committed.rows[0]?.value,
                                };
                            })
                          : command === "close"
                            ? Effect.as(Scope.close(owner, Exit.void), null)
                            : Effect.fail(new Error("Unknown benchmark command."));
                void Effect.runPromise(Scope.provide(work, owner)).then(
                    (value) => control.postMessage({ id, value }),
                    (error) => control.postMessage({ id, error: String(error) })
                );
            };
            control.postMessage({ ready: true, count, setupMs: performance.now() - setupAt });
            yield* Fiber.join(server);
        }),
        owner
    ).pipe(
        Effect.provideService(BrowserIndexedDb.IndexedDb, BrowserIndexedDb.make({ indexedDB, IDBKeyRange })),
        Effect.provideService(Tracer.Tracer, trace.tracer),
        Effect.tapCause((cause) =>
            Effect.sync(() => control.postMessage({ readyError: Cause.pretty(cause) }))
        )
    )
);
