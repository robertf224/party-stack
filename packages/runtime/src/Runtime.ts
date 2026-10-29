import { Context, Effect, Schema } from "effect";
import { alwaysOnlineConnectivity } from "./NetworkConnectivity.js";
import { RuntimePartition } from "./RuntimePartition.js";
import type { RuntimeOptions, BrowserAuthentication, NetworkConnectivity } from "./types.js";
import type { BlobBytesService } from "@party-stack/ontology-storage/blobs";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
    operation: Schema.String,
    cause: Schema.Defect(),
}) {}
/** Acquired platform capabilities and application-boundary bridges, owned by an Effect Scope. */
export interface RuntimeService {
    readonly owner: string;
    readonly namespace: string;
    readonly browserAuthentication?: BrowserAuthentication;
    readonly destroy: Effect.Effect<void, RuntimeError>;
    readonly tables: TablesService;
    readonly encryptionKeyring?: EncryptionKeyringService;
    readonly connectivity: NetworkConnectivity;
    readonly bytes: BlobBytesService;
}
export class Runtime extends Context.Service<Runtime, RuntimeService>()("@party-stack/runtime/Runtime") {
    /** Construct the runtime in the caller's Scope; platform Layers own their resources. */
    static readonly make = Effect.fnUntraced(function* (adapter: RuntimeOptions) {
        const partition = yield* RuntimePartition;

        const service = Runtime.of({
            ...partition,
            browserAuthentication: adapter.browserAuthentication,
            destroy: adapter.destroy ?? Effect.void,
            tables: adapter.tables,
            encryptionKeyring: adapter.encryptionKeyring,
            connectivity: adapter.connectivity ?? alwaysOnlineConnectivity,
            bytes: adapter.blobBytes,
        });
        return service;
    });
}
