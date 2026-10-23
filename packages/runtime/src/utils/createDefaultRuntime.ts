import { MemoryBlobBytesStore } from "../memory/MemoryBlobBytesStore.js";
import { defineRuntime } from "./defineRuntime.js";

export const createDefaultRuntime = defineRuntime((owner, namespace) => ({
    owner,
    namespace,
    blobBytes: new MemoryBlobBytesStore(),
}));
