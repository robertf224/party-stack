import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Context, Effect, Layer, ManagedRuntime, PubSub, Queue, Schema, Stream, Tracer } from "effect";
import { BlobBytesNotFoundError } from "./BlobBytesNotFoundError.js";
import { createRuntimeTraces } from "./tracing.js";
import type { RuntimeTraces } from "./tracing.js";
import type { RuntimeAdapter } from "./types.js";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export { createEncryptedSecretStore } from "./encryptedSecrets.js";
export { storageSubset } from "./collections/subset.js";
export { createRuntimeTraces } from "./tracing.js";
export type { RuntimeTrace, RuntimeTraces, RuntimeTraceStore } from "./tracing.js";
export {
    localCollectionOptions,
    replicatedCollectionOptions,
    makeLocalCollection,
    makeReplicatedCollection,
    scopedCollection,
    persistedCollectionOptions,
} from "./collections/collections.js";
export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
    operation: Schema.String,
    cause: Schema.Defect(),
}) {}
const attempt = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new RuntimeError({ operation, cause }) });

export interface RuntimeService {
    readonly adapter: RuntimeAdapter;
    readonly scope: import("effect").Scope.Scope;
    readonly tables: TablesService;
    readonly encryptionKeyring?: import("@party-stack/ontology-storage/encrypted").EncryptionKeyringService;
    readonly connectivity: Stream.Stream<boolean>;
    readonly online: Effect.Effect<boolean>;
    readonly changes: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, import("effect").Scope.Scope>;
    readonly externalChanges: Stream.Stream<void>;
    readonly notify: Effect.Effect<void>;
    readonly bytes: {
        read(id: string): Effect.Effect<Blob | undefined, RuntimeError>;
        write(id: string, value: Blob): Effect.Effect<void, RuntimeError>;
        delete(id: string): Effect.Effect<void, RuntimeError>;
    };
}
export class Runtime extends Context.Service<Runtime, RuntimeService>()("@party-stack/runtime/Runtime") {
    /** Construct the runtime in the caller's Scope; platform Layers own their resources. */
    static readonly make = Effect.fnUntraced(function* (adapter: RuntimeAdapter) {
        const tables = yield* adapter.tables ?? Memory.make();
        const encryptionKeyring = adapter.encryptionKeyring ? yield* adapter.encryptionKeyring : undefined;
        const events = yield* PubSub.sliding<void>(1);
        const external = yield* PubSub.sliding<void>(1);
        yield* Effect.addFinalizer(() => PubSub.shutdown(external));
        yield* Effect.addFinalizer(() => PubSub.shutdown(events));
        if (adapter.storageNotifications)
            yield* Effect.acquireRelease(
                Effect.sync(() =>
                    adapter.storageNotifications!.subscribe(() => {
                        PubSub.publishUnsafe(events, undefined);
                        PubSub.publishUnsafe(external, undefined);
                    })
                ),
                (unsubscribe) => Effect.sync(unsubscribe)
            );
        const connectivity = Stream.callback<boolean>((queue) =>
            Effect.acquireRelease(
                Effect.sync(() => {
                    const unsubscribe = adapter.connectivity?.subscribe((value) => {
                        Queue.offerUnsafe(queue, value);
                    });
                    Queue.offerUnsafe(queue, adapter.connectivity?.isConnected !== false);
                    return unsubscribe;
                }),
                (unsubscribe) => Effect.sync(() => unsubscribe?.())
            )
        );
        return Runtime.of({
            adapter,
            scope: yield* Effect.scope,
            tables,
            encryptionKeyring,
            connectivity,
            online: Effect.sync(() => adapter.connectivity?.isConnected !== false),
            changes: Stream.fromPubSub(events),
            subscribeChanges: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
            externalChanges: Stream.fromPubSub(external),
            notify: PubSub.publish(events, undefined).pipe(
                Effect.andThen(Effect.sync(() => adapter.storageNotifications?.publish()))
            ),
            bytes: {
                read: Effect.fn("Runtime.bytes.read")(function* (id: string) {
                    return yield* attempt("bytes.read", async () => {
                        try {
                            return await adapter.blobBytes.read(id);
                        } catch (cause) {
                            if (cause instanceof BlobBytesNotFoundError) return undefined;
                            throw cause;
                        }
                    });
                }),
                write: Effect.fn("Runtime.bytes.write")(function* (id: string, value: Blob) {
                    yield* attempt("bytes.write", () => adapter.blobBytes.write(id, value));
                }),
                delete: Effect.fn("Runtime.bytes.delete")(function* (id: string) {
                    yield* attempt("bytes.delete", () => adapter.blobBytes.delete(id));
                }),
            },
        });
    });

    /** Compatibility for already constructed platform adapters. */
    static readonly layer = (adapter: RuntimeAdapter) => Layer.effect(Runtime, Runtime.make(adapter));
}
const disposed = new WeakSet<RuntimeAdapter>();
const runtimes = new WeakMap<
    RuntimeAdapter,
    {
        runtime: ManagedRuntime.ManagedRuntime<Runtime, unknown>;
        traces: RuntimeTraces;
        closed?: boolean;
        closing?: Promise<void>;
    }
>();
/** One managed Effect scope per application runtime; Promise methods are framework boundaries. */
export function runtimeEffects(adapter: RuntimeAdapter) {
    if (disposed.has(adapter)) throw new Error("Runtime is closed.");
    const existing = runtimes.get(adapter);
    if (existing?.closed) throw new Error("Runtime is closed.");
    if (existing) return existing;
    const traces = createRuntimeTraces();
    const layer = Runtime.layer(adapter).pipe(
        Layer.provideMerge(Layer.succeed(Tracer.Tracer, traces.tracer))
    );
    const value = { runtime: ManagedRuntime.make(layer), traces };
    runtimes.set(adapter, value);
    return value;
}
/** Framework boundary over a scoped platform Layer. Both facades share this one runtime. */
export async function createRuntimeAdapter<E>(layer: Layer.Layer<Runtime, E>): Promise<RuntimeAdapter> {
    const traces = createRuntimeTraces();
    const runtime = ManagedRuntime.make(
        layer.pipe(Layer.provideMerge(Layer.succeed(Tracer.Tracer, traces.tracer)))
    );
    try {
        const service = await runtime.runPromise(Runtime);
        const binding = { runtime, traces };
        const raw = service.adapter;
        let destroying: Promise<void> | undefined;
        const adapter: RuntimeAdapter = {
            ...raw,
            tables: Effect.succeed(service.tables),
            encryptionKeyring: service.encryptionKeyring
                ? Effect.succeed(service.encryptionKeyring)
                : undefined,
            cleanup: () => disposeRuntimeEffects(adapter),
            destroy: raw.destroy
                ? () =>
                      (destroying ??= disposeRuntimeEffects(adapter)
                          .then(() => raw.destroy!())
                          .then(() => undefined))
                : undefined,
        };
        runtimes.set(raw, binding);
        runtimes.set(adapter, binding);
        return adapter;
    } catch (cause) {
        await runtime.dispose();
        throw cause;
    }
}

export async function disposeRuntimeEffects(adapter: RuntimeAdapter): Promise<void> {
    disposed.add(adapter);
    const existing = runtimes.get(adapter);
    if (existing) {
        existing.closed = true;
        existing.closing ??= existing.runtime.dispose();
        await existing.closing;
    }
}
