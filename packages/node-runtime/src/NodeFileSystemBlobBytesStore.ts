import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
    byteSource,
    type ByteInput,
    type ByteSource,
    byteIO,
    type BlobBytesService,
} from "@party-stack/runtime";
import { Effect, Stream } from "effect";

export interface NodeFileSystemBlobBytesStoreOptions {
    directory: string;
}

function fileName(id: string): string {
    return createHash("sha256").update(id).digest("hex");
}

export class NodeFileSystemBlobBytesStore implements BlobBytesService {
    readonly #directory: string;

    readonly write = (id: string, value: ByteInput) => byteIO((signal) => this.#write(id, value, signal));
    readonly read = (id: string) =>
        Effect.tryPromise(() => this.#read(id)).pipe(
            Effect.map((value) => (value === undefined ? undefined : byteSource(value)))
        );
    readonly delete = (id: string) => Effect.tryPromise(() => this.#delete(id));
    readonly clear = () => Effect.tryPromise(() => this.#clear());

    constructor(options: NodeFileSystemBlobBytesStoreOptions) {
        this.#directory = options.directory;
    }

    async #write(id: string, input: ByteInput, signal?: AbortSignal): Promise<void> {
        await mkdir(this.#directory, { recursive: true });
        const target = this.#path(id);
        const temporary = join(this.#directory, `.${fileName(id)}.${randomUUID()}.tmp`);
        try {
            await pipeline(
                Readable.from(Stream.toAsyncIterable(byteSource(input).stream)),
                createWriteStream(temporary),
                { signal }
            );
            signal?.throwIfAborted();
            await rename(temporary, target);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async #read(id: string): Promise<ByteSource | undefined> {
        try {
            const path = this.#path(id);
            const info = await stat(path);
            return {
                size: info.size,
                type: "application/octet-stream",
                stream: Stream.suspend(() =>
                    Stream.fromAsyncIterable(createReadStream(path), (cause) => cause)
                ),
            };
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    }

    async #delete(id: string): Promise<void> {
        await rm(this.#path(id), { force: true });
    }

    async #clear(): Promise<void> {
        await rm(this.#directory, { recursive: true, force: true });
    }

    #path(id: string): string {
        return join(this.#directory, fileName(id));
    }
}
