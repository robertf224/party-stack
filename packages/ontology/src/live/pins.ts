import { BackendError } from "@party-stack/ontology-backend";
import {
    makeReplica,
    pinOntology,
    pinMutators,
    pinRecordKey,
    pinDefinitionKey,
    type PinRecord,
    type PinWrite,
} from "@party-stack/ontology-replica";
import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import { Runtime } from "@party-stack/runtime";
import { BasicIndex, createLiveQueryCollection, eq, and, type Collection } from "@tanstack/db";
import { Effect, Fiber, Scope, Stream, Schema } from "effect";
import { persistedCollectionOptions, scopedCollection } from "../tanstack/collections.js";
import { ontologySubset } from "../tanstack/subset.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { QueryDocument } from "@party-stack/ontology-spec";
import type { DbClient } from "@tanstack/db";

export type PinInputs = Readonly<Record<string, unknown>>;
export type NoPinInputs = Record<string, never>;
declare const pinInputType: unique symbol;
export interface PinDescriptor<Inputs extends PinInputs = NoPinInputs> {
    readonly name: string;
    readonly query: QueryDocument;
    readonly attachments: "none" | "all";
    readonly [pinInputType]?: Inputs;
}
/** Pure metadata; binding it does not request or replace a download. */
export function definePin<Inputs extends PinInputs = NoPinInputs>(
    name: string,
    options: { readonly query: QueryDocument; readonly attachments?: "none" | "all" }
): PinDescriptor<Inputs> {
    return {
        name: Schema.decodeUnknownSync(Schema.NonEmptyString)(name),
        query: Schema.decodeUnknownSync(QueryDocumentSchema)(options.query),
        attachments: options.attachments ?? "none",
    };
}
export type PinInputArgs<Inputs extends PinInputs> = {} extends Inputs ? [inputs?: Inputs] : [inputs: Inputs];
export interface BoundPins<Inputs extends PinInputs> {
    readonly collection: Collection<PinRecord<Inputs>>;
    readonly id: (...args: PinInputArgs<Inputs>) => string;
    readonly set: (...args: PinInputArgs<Inputs>) => Promise<void>;
    readonly remove: (...args: PinInputArgs<Inputs>) => Promise<void>;
    readonly update: (change: {
        readonly set?: readonly Inputs[];
        readonly remove?: readonly Inputs[];
    }) => Promise<void>;
    /** Remove this named family across all query revisions. */
    readonly clear: () => Promise<void>;
}
export interface OntologyPins {
    <Inputs extends PinInputs>(definition: PinDescriptor<Inputs>): BoundPins<Inputs>;
    readonly collection: Collection<PinRecord, string>;
    readonly remove: (id: string) => Promise<void>;
    readonly clear: (name: string) => Promise<void>;
}

export const makeOntologyPins = Effect.fnUntraced(function* (options: {
    readonly backend: Effect.Effect<OntologyBackendService, BackendError, Scope.Scope>;
    readonly dbClient: DbClient;
}) {
    const runtime = yield* Runtime;
    const owner = yield* Effect.scope;
    const captured = yield* Effect.context<Runtime>();
    // This is a scoped replica resource, not a result cache. Merely opening an
    // application view does not open the administrative transport or acquire pins.
    const control = yield* Effect.cached(
        Scope.provide(
            Effect.gen(function* () {
                const backend = yield* options.backend;
                return yield* makeReplica({
                    id: JSON.stringify([runtime.namespace, "pin-view"]),
                    ir: pinOntology,
                    backend,
                    context: {},
                    mutators: pinMutators,
                });
            }).pipe(Effect.provideService(Runtime, runtime)),
            owner
        )
    );
    const collection = yield* scopedCollection(
        yield* persistedCollectionOptions<PinRecord, string>({
            id: JSON.stringify([runtime.namespace, "pins"]),
            getKey: (row) => row.id,
            primaryKey: "id",
            changes: Stream.empty,
            load: (subset) =>
                Effect.flatMap(control, (replica) =>
                    replica.readSubset(ontologySubset(subset, pinOntology, "Pin"))
                ).pipe(
                    Effect.map((rows) =>
                        rows.map((row) => ({ key: row.key, value: row.value as unknown as PinRecord }))
                    )
                ),
            observe: (subset) =>
                Stream.unwrap(
                    Effect.map(control, (replica) =>
                        replica.observeSubset(ontologySubset(subset, pinOntology, "Pin"))
                    )
                ).pipe(
                    Stream.map((batch) => ({
                        ...batch,
                        rows: batch.rows.map((row) => ({
                            key: row.key,
                            value: row.value as unknown as PinRecord,
                        })),
                    }))
                ),
            acquireDemand: (subset) =>
                Effect.flatMap(control, (replica) =>
                    replica.demand.acquire(ontologySubset(subset, pinOntology, "Pin"))
                ),
        }),
        options.dbClient
    );
    const update = (change: { set?: readonly PinWrite[]; remove?: readonly string[]; clearName?: string }) =>
        Effect.runPromiseWith(captured)(
            Effect.suspend(() =>
                owner.state._tag === "Closed"
                    ? Effect.fail(
                          new BackendError({
                              operation: "pins",
                              kind: "Unavailable",
                              retryable: false,
                              message: "Ontology view is closed.",
                          })
                      )
                    : Effect.flatMap(
                          Effect.forkIn(
                              control.pipe(
                                  Effect.flatMap((replica) =>
                                      replica.actions.apply({
                                          id: crypto.randomUUID(),
                                          name: "updatePins",
                                          parameters: { change },
                                      })
                                  ),
                                  Effect.asVoid
                              ),
                              owner,
                              { startImmediately: true }
                          ),
                          Fiber.join
                      )
            )
        );
    const families = new Map<string, BoundPins<PinInputs>>();
    yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
            for (const family of families.values()) await family.collection.cleanup({ dependents: true });
            families.clear();
        })
    );
    const bind = <Inputs extends PinInputs>(descriptor: PinDescriptor<Inputs>): BoundPins<Inputs> => {
        const definition = pinDefinitionKey(descriptor);
        const key = JSON.stringify([descriptor.name, definition]);
        const previous = families.get(key);
        if (previous) return previous as BoundPins<Inputs>;
        const write = (inputs?: PinInputs): PinWrite => ({ ...descriptor, inputs: inputs ?? {} });
        const family: BoundPins<PinInputs> = {
            collection: createLiveQueryCollection({
                id: `${collection.id}:${key}`,
                autoIndex: "eager",
                defaultIndexType: BasicIndex,
                query: (q) =>
                    q
                        .from({ pin: collection })
                        .where(({ pin }) =>
                            and(eq(pin.name, descriptor.name), eq(pin.definition, definition))
                        )
                        .select(({ pin }) => ({
                            id: pin.id,
                            name: pin.name,
                            definition: pin.definition,
                            query: pin.query,
                            inputs: pin.inputs,
                            attachments: pin.attachments,
                            generation: pin.generation,
                            ready: pin.ready,
                            error: pin.error,
                        })),
                getKey: (pin) => pin.id,
                // DB adds virtual columns to live-query rows. The public view keeps
                // the validated Pin shape, narrowed to this descriptor's inputs.
            }) as unknown as BoundPins<PinInputs>["collection"],
            id: (inputs) => pinRecordKey(write(inputs)),
            set: (inputs) => update({ set: [write(inputs)] }),
            remove: (inputs) => update({ remove: [pinRecordKey(write(inputs))] }),
            update: (change) =>
                update({
                    set: change.set?.map(write),
                    remove: change.remove?.map((input) => pinRecordKey(write(input))),
                }),
            clear: () => update({ clearName: descriptor.name }),
        };
        families.set(key, family);
        return family as BoundPins<Inputs>;
    };
    return Object.assign(bind, {
        collection,
        remove: (id: string) => update({ remove: [id] }),
        clear: (name: string) => update({ clearName: name }),
    }) satisfies OntologyPins;
});

export type { PinRecord } from "@party-stack/ontology-replica";
