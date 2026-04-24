// we can scan all the things *into* a local tanstack db collection for queries if we want, and just drive based on a kv store?

import { createCollection, createTransaction } from "@tanstack/db";

// create lifecycle
// create/stage (us) - store file locally in adapter
// possibly get blob later, potentially set a blob to be retained, possibly delete
// upload blob (create attachment, upload during mutation, etc.) (caller)
// on success: mark as uploaded, sync final metadata, optionally sync new blob (or don't to avoid slowness if metadata is unchanged)
// on error: mark as failed (will be evicted)

// LRU, w/ size bias

// AttachmentStorageAdapter
// save (blob, id) => promise<blob>
// get (id) => promise<blob>
// ...

// createEffect?

// flow
// ----
// pick file
// intent to create attachment directly (or run action that does it)
// so we need to return mutator that creates the blob record (and then either createAttachment or action that takes a file)

type BlobRef = {
    id: string;
    type: string;
    size: string;
    state: "pending" | "persisting" | "completed" | "failed";
};

interface LocalBlobStorage {
    stage: (blob: Blob, id: string) => Promise<BlobRef>;
    complete: (id: string) => Promise<BlobRef>;
    get: (id: string) => Promise<BlobRef>;
    read: (id: string) => Promise<Blob>;
    list: () => Promise<BlobRef[]>;
    // retain
    // release
    // listen
}

const storage: LocalBlobStorage = {};

const file: File = new File([], "test.jpeg");

const blobId = crypto.randomUUID();

const collection = createCollection({});

async function createAttachment(blob: Blob): Promise<BlobRef> {
    const blobRef = await storage.stage(file, blobId);
    const transaction = createTransaction({
        mutationFn: async () => {
            // upload blob
            await storage.complete(blobRef.id); // maybe sync in completed blob?
        },
    });
    // if this was proper mutation we would mutate and add blob ref to collection here
    await transaction.commit();
}

function useBlob(id: string) {
    // storage.retain(id);
    // read blob
    // return () => storage.release(id);
}
