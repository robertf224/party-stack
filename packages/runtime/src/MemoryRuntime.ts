import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Layer } from "effect";
import { makeMemoryEncryptionKeyring } from "./encryptionKeys.js";
import { MemoryBlobBytesStore } from "./memory/MemoryBlobBytesStore.js";
import { Runtime } from "./Runtime.js";

export const make = Effect.fnUntraced(function* () {
    return yield* Runtime.make({
        tables: yield* Memory.make(),
        blobBytes: new MemoryBlobBytesStore(),
        encryptionKeyring: yield* makeMemoryEncryptionKeyring(),
    });
});
export const layer = Layer.effect(Runtime, make());
