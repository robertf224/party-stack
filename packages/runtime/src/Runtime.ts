import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Context, Effect, Layer, PubSub, Queue, Schema, Stream, Tracer } from "effect";
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
    readonly context: Context.Context<Runtime>;
    readonly traces: RuntimeTraces;
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
        const existing = (adapter as BoundAdapter)[serviceKey];
        if (existing) return existing;
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
        const captured = yield* Effect.context<never>();
        const traces = createRuntimeTraces();
        let service: RuntimeService;
        service = Runtime.of({
            get context() {
                return Context.add(Context.add(captured, Runtime, service), Tracer.Tracer, traces.tracer);
            },
            traces,
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
        Object.defineProperty(adapter, serviceKey, { value: service, configurable: true });
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                delete (adapter as BoundAdapter)[serviceKey];
            })
        );
        return service;
    });

    /** Acquire platform capabilities in the caller's scope. */
    static readonly layer = (adapter: RuntimeAdapter) => Layer.effect(Runtime, Runtime.make(adapter));
}
const serviceKey = Symbol.for("@party-stack/runtime/scoped-service");
type BoundAdapter = RuntimeAdapter & { [serviceKey]?: RuntimeService };

/** Capture an already acquired scoped service for a non-Effect application boundary. */
export function getRuntime(adapter: RuntimeAdapter): RuntimeService {
    const service = (adapter as BoundAdapter)[serviceKey];
    if (!service) throw new Error("Runtime is not acquired or its scope is closed.");
    return service;
}
