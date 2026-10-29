import { Effect, Layer } from "effect";
import { makeMemoryEncryptionKeyring } from "./encryptionKeys.js";
import { MemoryBlobBytesStore } from "./memory/MemoryBlobBytesStore.js";
import { Runtime } from "./Runtime.js";
import { RuntimePartition } from "./RuntimePartition.js";

export const make = Effect.fnUntraced(function* () {
    const partition = yield* RuntimePartition;
    return yield* Runtime.make({
        ...partition,
        blobBytes: new MemoryBlobBytesStore(),
        encryptionKeyring: makeMemoryEncryptionKeyring(),
    });
});
export const layer = Layer.effect(Runtime, make());
