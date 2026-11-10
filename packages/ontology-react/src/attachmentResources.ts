import { createContext } from "react";
import { AttachmentPromiseCache } from "./attachmentPromiseCache.js";

export const AttachmentResourcesContext = createContext<AttachmentPromiseCache | undefined>(undefined);

export function makeAttachmentResources() {
    const cache = new AttachmentPromiseCache();
    return { cache, cleanup: async () => cache.dispose() };
}
