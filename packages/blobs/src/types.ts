export interface BlobRef {
    id: string;
    type: string;
    size: number;
    // last accessed
    state: "pending" | "persisted" | "failed"; // do we want failed?
}

export interface LocalBlobStorageAdapter {
    put: (id: string, blob: Blob) => Promise<BlobRef>;
    get: (id: string) => Promise<BlobRef>;
    read: (id: string) => Promise<Blob>;
    list: () => Promise<BlobRef[]>;
}

// need beyond what we should normally expect from a fs: last access time, status
// - last access time we could try touch hack, or keep a side meta store
// - status we could do provider externally (e.g. offline transactions in tanstack db)
// - also may want redirects for local/remote ids...

// RemoteBlobStorageAdapter
// => get, read

// BlobStorage
// stage, commit, get, read, list, retain, release, listen
// stage: (blob: Blob, id: string) => Promise<BlobRef>;
// complete: (id: string) => Promise<BlobRef>; // finalize? commit? also can this take a final blob? and maybe a remote id?
// retain
// release
// listen

// Compose these into a BlobStorage,
// which handles pull-through read caching and garbage collection.
// - don't clean up staged files, gc persisted files based on LRU, size
// can we also take an optional status provider?  so for tanstack db we could use peek outbox.
// else we can store a json or something as a blob locally?

// chapter example: write/stage local file, get back signed GCP bucket url on the other side
// so remote is like, lookup in table to get url, read by reading url

// examples:
// ditto
// foundry
// salesforce
// chapter
// outlook
// gmail
