import { OPFSBlobBytesStore } from "../web/OPFSBlobBytesStore.js";
import type { RuntimeServices } from "../types.js";

export function webOnline(owner: string, namespace: string): RuntimeServices {
    return {
        blobBytes: new OPFSBlobBytesStore({
            directoryName: `party-stack:${owner}:${namespace}:blobs`,
        }),
        locks: navigator.locks,
    };
}
