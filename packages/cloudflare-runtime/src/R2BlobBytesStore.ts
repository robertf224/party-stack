import type { BlobBytesStore } from "@party-stack/runtime";

export interface R2ObjectBodyLike {
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: {
        contentType?: string;
    };
}

export interface R2ListedObjectLike {
    key: string;
}

export interface R2ObjectsLike {
    objects: readonly R2ListedObjectLike[];
    truncated: boolean;
    cursor?: string;
}

export interface R2BucketLike {
    put(
        key: string,
        value: Blob | ArrayBuffer,
        options?: {
            httpMetadata?: {
                contentType?: string;
            };
        }
    ): Promise<unknown>;
    get(key: string): Promise<R2ObjectBodyLike | null>;
    delete(keys: string | readonly string[]): Promise<void>;
    list(options?: { prefix?: string; cursor?: string }): Promise<R2ObjectsLike>;
}

export class R2BlobNotFoundError extends Error {
    constructor(readonly key: string) {
        super(`R2 blob bytes not found for "${key}".`);
        this.name = "R2BlobNotFoundError";
    }
}

async function hashKeyPart(value: string): Promise<string> {
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index++) {
        view.setUint16(index * 2, value.charCodeAt(index));
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of digest) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function deletePrefix(bucket: R2BucketLike, prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
        const listed = await bucket.list({
            prefix,
            ...(cursor ? { cursor } : {}),
        });
        const keys = listed.objects.map((object) => object.key);
        if (keys.length > 0) {
            await bucket.delete(keys);
        }
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
}

async function installationPrefix(installationId: string): Promise<string> {
    return `party-stack/blobs/${await hashKeyPart(installationId)}/`;
}

export async function destroyR2Installation(bucket: R2BucketLike, installationId: string): Promise<void> {
    await deletePrefix(bucket, await installationPrefix(installationId));
}

export interface R2BlobBytesStoreOptions {
    bucket: R2BucketLike;
    installationId: string;
    owner: string;
    namespace: string;
}

export class R2BlobBytesStore implements BlobBytesStore {
    readonly prefix: Promise<string>;
    private readonly inFlight = new Set<Promise<unknown>>();
    private closed = false;

    constructor(private readonly options: R2BlobBytesStoreOptions) {
        this.prefix = Promise.all([
            installationPrefix(options.installationId),
            hashKeyPart(options.owner),
            hashKeyPart(options.namespace),
        ]).then(([installation, owner, namespace]) => `${installation}${owner}/${namespace}/`);
    }

    async key(id: string): Promise<string> {
        return `${await this.prefix}${await hashKeyPart(id)}`;
    }

    private track<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this.closed) {
            return Promise.reject(new Error("R2 blob byte store is closed."));
        }
        const pending = operation();
        this.inFlight.add(pending);
        void pending.then(
            () => this.inFlight.delete(pending),
            () => this.inFlight.delete(pending)
        );
        return pending;
    }

    write(id: string, blob: Blob): Promise<void> {
        return this.track(async () => {
            await this.options.bucket.put(await this.key(id), blob, {
                httpMetadata: {
                    contentType: blob.type || "application/octet-stream",
                },
            });
        });
    }

    read(id: string): Promise<Blob> {
        return this.track(async () => {
            const key = await this.key(id);
            const object = await this.options.bucket.get(key);
            if (!object) {
                throw new R2BlobNotFoundError(key);
            }
            return new Blob([await object.arrayBuffer()], {
                type: object.httpMetadata?.contentType ?? "application/octet-stream",
            });
        });
    }

    delete(id: string): Promise<void> {
        return this.track(async () => {
            await this.options.bucket.delete(await this.key(id));
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        await Promise.allSettled(this.inFlight);
    }

    async destroy(): Promise<void> {
        await this.close();
        await deletePrefix(this.options.bucket, await this.prefix);
    }
}
