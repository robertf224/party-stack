import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobBytesStore } from "@party-stack/runtime";

export interface NodeFileSystemBlobBytesStoreOptions {
    directory: string;
}

function fileName(id: string): string {
    return createHash("sha256").update(id).digest("hex");
}

export class NodeFileSystemBlobBytesStore implements BlobBytesStore {
    readonly #directory: string;

    constructor(options: NodeFileSystemBlobBytesStoreOptions) {
        this.#directory = options.directory;
    }

    async write(id: string, blob: Blob): Promise<void> {
        await mkdir(this.#directory, { recursive: true });
        const target = this.#path(id);
        const temporary = join(this.#directory, `.${fileName(id)}.${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, new Uint8Array(await blob.arrayBuffer()));
            await rename(temporary, target);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async read(id: string): Promise<Blob> {
        try {
            return new Blob([await readFile(this.#path(id))]);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error(`Blob bytes not found for "${id}".`, {
                    cause: error,
                });
            }
            throw error;
        }
    }

    async delete(id: string): Promise<void> {
        await rm(this.#path(id), { force: true });
    }

    async clear(): Promise<void> {
        await rm(this.#directory, { recursive: true, force: true });
    }

    #path(id: string): string {
        return join(this.#directory, fileName(id));
    }
}
