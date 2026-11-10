import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { equalValues } from "@party-stack/ontology-spec/query";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { Schema } from "effect";
import { pinMutators, pinOntology, PinRecordSchema } from "./pinModel.js";
import { makeQueryPin } from "./pins.js";
import type { PinRecord, PinUpdate, PinWrite } from "./pinModel.js";
import type { PinState } from "./pins.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

export interface ReplicaPins {
    readonly backend: Effect.Effect<OntologyBackendService, BackendError>;
    readonly list: Effect.Effect<readonly PinRecord[], BackendError>;
    readonly changes: Stream.Stream<readonly PinRecord[], BackendError>;
    readonly set: (pin: PinWrite) => Effect.Effect<void, BackendError>;
    readonly remove: (id: string) => Effect.Effect<void, BackendError>;
    readonly update: (change: PinUpdate) => Effect.Effect<void, BackendError>;
    readonly clear: (name: string) => Effect.Effect<void, BackendError>;
}

/** An ordinary owned ontology for durable intent/status. The reconciler alone
 * acquires graph demand; writes use the normal action/receipt/journal path. */
export const makePinManager = Effect.fn("Replica.pins")(function* (
    options: Parameters<typeof makeQueryPin>[0]
) {
    const { tables } = options;
    const state = Table.make<PinState>({ name: JSON.stringify(["replica", options.namespace, "query-pin"]) });
    const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(Effect.mapError((cause) => classifyBackendFailure("replica.pins", cause)));
    const backend = yield* makeOwnedBackend({
        ir: pinOntology,
        tables,
        namespace: JSON.stringify(["replica", options.namespace, "pin-control"]),
        maintenance: false,
        mutators: {
            updatePins: (tx, invocation) =>
                pinMutators.updatePins(
                    {
                        ...tx,
                        query: (query, settings) =>
                            executeQuery(query, { reader: { ...tx, ir: pinOntology }, ...settings }).pipe(
                                Effect.map((result) => result.value)
                            ),
                        put: (type, value) =>
                            Effect.gen(function* () {
                                const record =
                                    yield* Schema.decodeUnknownEffect(PinRecordSchema)(value).pipe(boundary);
                                // Validate against the managed ontology before accepting intent.
                                // This is schema/input validation, never an upstream read.
                                yield* executeQuery(record.query, {
                                    reader: { ir: options.ir, loadSubset: () => Effect.succeed([]) },
                                    inputs: record.inputs,
                                    context: options.context,
                                    mode: "entity",
                                });
                                const previous = yield* boundary(tables.get(state, record.id));
                                yield* tx.put(type, value);
                                yield* boundary(
                                    tables.put(state, record.id, {
                                        desired: {
                                            query: record.query,
                                            inputs: record.inputs,
                                            attachments: record.attachments,
                                            generation: record.generation,
                                        },
                                        installed: previous?.installed,
                                    })
                                );
                            }),
                        delete: (type, id) =>
                            Effect.gen(function* () {
                                const previous = yield* boundary(tables.get(state, id));
                                yield* tx.delete(type, id);
                                if (previous)
                                    yield* boundary(
                                        tables.put(state, id, {
                                            ...previous,
                                            removed: true,
                                            desired: { ...previous.desired, generation: invocation.id },
                                        })
                                    );
                            }),
                    },
                    invocation
                ),
        },
    });
    const owner = yield* Effect.scope;
    const queue = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const jobs = new Map<
        string,
        {
            readonly scope: Scope.Closeable;
            readonly pin: Effect.Success<ReturnType<typeof makeQueryPin>>;
            generation: string;
        }
    >();
    const wake = Queue.offer(queue, undefined).pipe(Effect.asVoid);
    const report = (id: string) =>
        backend.storage
            .transaction((tx) =>
                Effect.gen(function* () {
                    const current = yield* boundary(tables.get(state, id));
                    const row = yield* tx.get("Pin", id);
                    if (!row || !current || current.removed || row.generation !== current.desired.generation)
                        return;
                    const ready =
                        current.desired.generation === current.installed?.generation && !current.error;
                    if (row.ready === ready && equalValues(row.error, current.error)) return;
                    yield* tx.put("Pin", { ...row, ready, error: current.error });
                })
            )
            .pipe(Effect.andThen(wake));
    const reconcile = Effect.fn("Replica.pins.reconcile")(function* () {
        const desired = (yield* boundary(tables.query(state))).filter((row) => row.key !== "head");
        const present = new Set(desired.map((row) => String(row.key)));
        for (const [id, job] of jobs) {
            if (present.has(id)) continue;
            jobs.delete(id);
            yield* Scope.close(job.scope, Exit.void);
        }
        for (const row of desired) {
            const id = String(row.key);
            const generation = row.value.desired.generation;
            let job = jobs.get(id);
            if (!job) {
                const scope = yield* Scope.fork(owner);
                const pin = yield* Scope.provide(
                    makeQueryPin({ ...options, id, onStatusChanged: report(id) }),
                    scope
                );
                job = { scope, pin, generation };
                jobs.set(id, job);
                if (!options.live) yield* pin.refresh;
            } else if (job.generation !== generation) {
                job.generation = generation;
                yield* job.pin.scheduleRefresh();
            }
        }
    });
    // Subscribe before the initial inventory read. The normal owned journal is
    // the sole notification source for commands, including remote tab writes.
    const changes = yield* backend.changes!.watch!;
    if (options.live) {
        yield* Stream.runForEach(changes, () => wake).pipe(Effect.forkScoped);
        yield* Effect.forever(
            Queue.take(queue).pipe(
                Effect.andThen(reconcile),
                Effect.catch((error) => Effect.logError("Pin inventory reconciliation failed", error))
            )
        ).pipe(Effect.forkScoped);
        yield* wake;
    } else yield* reconcile();
    const update = (change: PinUpdate) =>
        backend
            .applyAction({
                id: crypto.randomUUID(),
                name: "updatePins",
                parameters: { change },
            })
            .pipe(Effect.andThen(options.live ? Effect.void : reconcile()), Effect.asVoid);
    const list = backend
        .loadSubset(objectSubset("Pin"))
        .pipe(
            Effect.flatMap((snapshot) =>
                Effect.forEach(snapshot.rows, (row) =>
                    Schema.decodeUnknownEffect(PinRecordSchema)(row.value).pipe(boundary)
                )
            )
        );
    const pins: ReplicaPins = {
        backend: Effect.succeed(backend),
        list,
        changes: Stream.unwrap(
            Effect.map(backend.changes!.watch!, (events) =>
                Stream.concat(Stream.make(undefined), events).pipe(Stream.mapEffect(() => list))
            )
        ),
        update,
        set: (pin) => update({ set: [pin] }),
        remove: (id) => update({ remove: [id] }),
        clear: (name) => update({ clearName: name }),
    };
    return {
        ...pins,
        refresh: Effect.gen(function* () {
            yield* reconcile();
            for (const job of jobs.values()) yield* job.pin.refresh;
        }),
    };
});
