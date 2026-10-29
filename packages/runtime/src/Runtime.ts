import { byteSource, type ByteInput, type ByteSource } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Context, Effect, Queue, Schema, Stream } from "effect";
import { RuntimePartition } from "./RuntimePartition.js";
import { createRuntimeTraces } from "./tracing.js";
import type { RuntimeTraces } from "./tracing.js";
import type { RuntimeOptions, BrowserAuthentication } from "./types.js";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export { createRuntimeTraces } from "./tracing.js";
export type { RuntimeTrace, RuntimeTraces, RuntimeTraceStore } from "./tracing.js";
export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
    operation: Schema.String,
    cause: Schema.Defect(),
}) {}
/** Acquired platform capabilities and application-boundary bridges, owned by an Effect Scope. */
export interface RuntimeService {
    readonly traces: RuntimeTraces;
    readonly owner: string;
    readonly namespace: string;
    readonly browserAuthentication?: BrowserAuthentication;
    readonly destroy: Effect.Effect<void, RuntimeError>;
    readonly tables: TablesService;
    readonly encryptionKeyring?: EncryptionKeyringService;
    readonly connectivity: Stream.Stream<boolean>;
    readonly online: Effect.Effect<boolean>;
    readonly bytes: {
        read(id: string): Effect.Effect<ByteSource | undefined, RuntimeError>;
        write(id: string, value: ByteInput): Effect.Effect<void, RuntimeError>;
        delete(id: string): Effect.Effect<void, RuntimeError>;
    };
}
export class Runtime extends Context.Service<Runtime, RuntimeService>()("@party-stack/runtime/Runtime") {
    /** Construct the runtime in the caller's Scope; platform Layers own their resources. */
    static readonly make = Effect.fnUntraced(function* (adapter: RuntimeOptions) {
        const partition = yield* RuntimePartition;
        const tables = yield* adapter.tables ?? Memory.make();
        const encryptionKeyring = adapter.encryptionKeyring ? yield* adapter.encryptionKeyring : undefined;
        const connectivity = Stream.callback<boolean>(
            (queue) =>
                Effect.acquireRelease(
                    Effect.sync(() => {
                        const unsubscribe = adapter.connectivity?.subscribe((value) => {
                            Queue.offerUnsafe(queue, value);
                        });
                        Queue.offerUnsafe(queue, adapter.connectivity?.isConnected !== false);
                        return unsubscribe;
                    }),
                    (unsubscribe) => Effect.sync(() => unsubscribe?.())
                ),
            { bufferSize: 1, strategy: "sliding" }
        );
        const traces = createRuntimeTraces();
        const service = Runtime.of({
            traces,
            ...partition,
            browserAuthentication: adapter.browserAuthentication,
            destroy: adapter.destroy ?? Effect.void,
            tables,
            encryptionKeyring,
            connectivity,
            online: Effect.sync(() => adapter.connectivity?.isConnected !== false),
            bytes: {
                read: (id) =>
                    adapter.blobBytes.read(id).pipe(
                        Effect.map((value) => (value === undefined ? undefined : byteSource(value))),
                        Effect.mapError((cause) => new RuntimeError({ operation: "bytes.read", cause }))
                    ),
                write: (id, value) =>
                    adapter.blobBytes
                        .write(id, value)
                        .pipe(
                            Effect.mapError((cause) => new RuntimeError({ operation: "bytes.write", cause }))
                        ),
                delete: (id) =>
                    adapter.blobBytes
                        .delete(id)
                        .pipe(
                            Effect.mapError((cause) => new RuntimeError({ operation: "bytes.delete", cause }))
                        ),
            },
        });
        return service;
    });
}
