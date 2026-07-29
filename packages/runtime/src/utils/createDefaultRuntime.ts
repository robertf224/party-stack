import { SingleProcessCoordination } from "@party-stack/coordination";
import { MemoryBlobBytesStore } from "../memory/MemoryBlobBytesStore.js";
import type { RuntimeAdapter } from "../types.js";

export function createDefaultRuntime(
    owner: string,
    namespace: string
): RuntimeAdapter {
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
}
