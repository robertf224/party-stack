import { byteSource, type ByteInput, byteIO, type BlobBytesService } from "@party-stack/runtime";
import { Effect, Stream } from "effect";

export interface OPFSBlobBytesStoreOptions {
    directoryName: string;
}

/** Preserve existing valid names. Composite partition keys contain JSON backslashes,
 * which OPFS rejects; hashes also keep addresses within filesystem component limits.
 * The reserved # prefix cannot collide with URI-encoded file IDs or un-hashed directories.
 */
async function opfsName(name: string): Promise<string> {
    const bytes = new TextEncoder().encode(name);
    if (
        bytes.length > 0 &&
        bytes.length <= 255 &&
        !/[\\/\0]/.test(name) &&
        name !== "." &&
        name !== ".." &&
        !name.startsWith("#")
    )
        return name;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return `#${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class OPFSBlobBytesStore implements BlobBytesService {
    #directoryName: string;

    readonly write = (id: string, value: ByteInput) => byteIO((signal) => this.#write(id, value, signal));
    readonly read = (id: string) =>
        Effect.tryPromise(() => this.#read(id)).pipe(
            Effect.map((value) => (value === undefined ? undefined : byteSource(value)))
        );
    readonly delete = (id: string) => Effect.tryPromise(() => this.#delete(id));
    readonly clear = () => Effect.tryPromise(() => this.#clear());

    constructor(options: OPFSBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async #write(id: string, input: ByteInput, signal?: AbortSignal): Promise<void> {
        const directory = await this.#directory();
        const fileHandle = await directory.getFileHandle(await opfsName(encodeURIComponent(id)), {
            create: true,
        });
        const writable = await fileHandle.createWritable();
        await Stream.toReadableStream(byteSource(input).stream).pipeTo(writable, { signal });
    }

    async #read(id: string): Promise<Blob | undefined> {
        try {
            const directory = await this.#directory();
            const fileHandle = await directory.getFileHandle(await opfsName(encodeURIComponent(id)));
            return await fileHandle.getFile();
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === "NotFoundError") return undefined;
            throw cause;
        }
    }

    async #delete(id: string): Promise<void> {
        const directory = await this.#directory();
        try {
            await directory.removeEntry(await opfsName(encodeURIComponent(id)));
        } catch (error) {
            if (error instanceof DOMException && error.name === "NotFoundError") {
                return;
            }
            throw error;
        }
    }

    async #clear(): Promise<void> {
        const root = await navigator.storage.getDirectory();
        try {
            await root.removeEntry(await opfsName(this.#directoryName), {
                recursive: true,
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === "NotFoundError") {
                return;
            }
            throw error;
        }
    }

    async #directory(): Promise<FileSystemDirectoryHandle> {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(await opfsName(this.#directoryName), { create: true });
    }
}
