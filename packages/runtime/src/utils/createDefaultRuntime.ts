import { SingleProcessCoordination } from "@party-stack/coordination";
import { MemoryBlobBytesStore } from "../memory/MemoryBlobBytesStore.js";
import { defineRuntime } from "./defineRuntime.js";

export const createDefaultRuntime = defineRuntime((
    owner,
    namespace
) => {
    const scope = `party-stack:${owner}:${namespace}`;
    const coordination =
        new SingleProcessCoordination({ scope });
    return {
        owner,
        namespace,
        blobBytes: new MemoryBlobBytesStore(),
        coordination,
        cleanup: () => coordination.close(),
    };
});
