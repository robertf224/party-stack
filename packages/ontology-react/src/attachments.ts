"use client";
import { use, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { AttachmentResourcesContext } from "./attachmentResources.js";
import { useOntology } from "./context.js";
import type { Entry } from "./attachmentPromiseCache.js";
import type { AttachmentMetadata } from "@party-stack/ontology";
import type { attachment } from "@party-stack/ontology/values";

const noSubscription = () => () => {};
const noEntry = () => undefined;

function useAttachmentValue(value: attachment | undefined) {
    const source = value?.source;
    const id = value?.id;
    const type = value?.type;
    const objectType = source?.objectType;
    const primaryKey = source?.primaryKey;
    const property = source?.property;
    return useMemo<attachment | undefined>(
        () =>
            id === undefined
                ? undefined
                : {
                      id,
                      ...(type === undefined ? {} : { type }),
                      ...(objectType === undefined || primaryKey === undefined || property === undefined
                          ? {}
                          : { source: { objectType, primaryKey, property } }),
                  },
        [id, type, objectType, primaryKey, property]
    );
}

function useAttachmentRead<A>(
    key: string | undefined,
    open: (signal: AbortSignal) => Promise<A>,
    close?: (value: A) => void
): A | undefined {
    const cache = useContext(AttachmentResourcesContext);
    const getSnapshot = useCallback(
        () => (cache && key !== undefined ? cache.get(key, open, close) : undefined),
        [cache, key, open, close]
    );
    const subscribe = useCallback(
        (listener: () => void) => {
            const entry = getSnapshot();
            return entry && cache ? cache.subscribe(entry, listener) : noSubscription();
        },
        [cache, getSnapshot]
    );
    // A committed subscription leases the URL. Snapshot consistency also prevents
    // committing a URL whose inactive entry expired during concurrent rendering.
    const entry: Entry<A> | undefined = useSyncExternalStore(subscribe, getSnapshot, noEntry);
    return entry ? use(entry.promise) : undefined;
}

/** Suspends for bytes and throws initial failures to the nearest error boundary.
 * Identical reads share an object URL within this view. Unused settled reads are
 * released after five minutes; closing the view aborts reads and revokes all URLs.
 */
export function useAttachmentUrl(value: attachment | undefined, options: { enabled?: boolean } = {}) {
    const ontology = useOntology();
    const handle = useAttachmentValue(value);
    const key = options.enabled !== false && handle ? JSON.stringify(["url", handle]) : undefined;
    const open = useCallback(
        async (signal: AbortSignal) =>
            URL.createObjectURL(await ontology.attachments.blob(handle!, { signal })),
        [ontology, handle]
    );
    const url = useAttachmentRead(key, open, URL.revokeObjectURL);
    return url;
}

/** Suspends until the selected metadata is available. Selection order does not
 * create duplicate reads, and changing the source creates a separate request.
 */
export function useAttachmentMetadata<const Fields extends readonly ("size" | "type" | "name")[]>(
    value: attachment | undefined,
    options: { select: Fields; enabled?: boolean }
) {
    const ontology = useOntology();
    const handle = useAttachmentValue(value);
    const fieldsKey = [...new Set(options.select)].sort().join(",");
    const select = useMemo(() => fieldsKey.split(",").filter(Boolean) as Fields[number][], [fieldsKey]);
    const key =
        options.enabled !== false && handle ? JSON.stringify(["metadata", handle, select]) : undefined;
    const open = useCallback(
        (signal: AbortSignal) => ontology.attachments.metadata(handle!, { select, signal }),
        [ontology, handle, select]
    );
    const data = useAttachmentRead(key, open) as Pick<AttachmentMetadata, Fields[number]> | undefined;
    return data;
}
