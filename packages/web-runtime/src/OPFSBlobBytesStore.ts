import { byteSource, type ByteInput, byteIO, type BlobBytesService } from "@party-stack/runtime";
import { Effect, Stream } from "effect";

export interface OPFSBlobBytesStoreOptions {
    directoryName: string;
}

function encodeFileName(id: string): string {
    return encodeURIComponent(id);
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
        const fileHandle = await directory.getFileHandle(encodeFileName(id), {
            create: true,
        });
        const writable = await fileHandle.createWritable();
        await Stream.toReadableStream(byteSource(input).stream).pipeTo(writable, { signal });
    }

    async #read(id: string): Promise<Blob | undefined> {
        try {
            const directory = await this.#directory();
            const fileHandle = await directory.getFileHandle(encodeFileName(id));
            return await fileHandle.getFile();
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === "NotFoundError") return undefined;
            throw cause;
        }
    }

    async #delete(id: string): Promise<void> {
        const directory = await this.#directory();
        try {
            await directory.removeEntry(encodeFileName(id));
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
            await root.removeEntry(this.#directoryName, {
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
        return root.getDirectoryHandle(this.#directoryName, { create: true });
    }
}
