import { byteSource, type ByteInput, byteIO, type BlobBytesService } from "@party-stack/runtime";
import { Effect, Stream } from "effect";
import { Directory, File, Paths } from "expo-file-system";
import { hashStorageName } from "./hashStorageName.js";

export interface ExpoFileSystemBlobBytesStoreOptions {
    directoryName: string;
}

export class ExpoFileSystemBlobBytesStore implements BlobBytesService {
    #directoryName: string;

    readonly write = (id: string, value: ByteInput) => byteIO((signal) => this.#write(id, value, signal));
    readonly read = (id: string) =>
        Effect.tryPromise(() => this.#read(id)).pipe(
            Effect.map((value) => (value === undefined ? undefined : byteSource(value)))
        );
    readonly delete = (id: string) => Effect.tryPromise(() => this.#delete(id));
    readonly clear = () => Effect.tryPromise(() => this.#clear());

    constructor(options: ExpoFileSystemBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async #write(id: string, input: ByteInput, signal?: AbortSignal): Promise<void> {
        const file = await this.#file(id);
        file.create({ intermediates: true, overwrite: true });
        try {
            await Stream.toReadableStream(byteSource(input).stream).pipeTo(file.writableStream(), { signal });
        } catch (error) {
            if (file.exists) file.delete();
            throw error;
        }
    }

    #read(id: string): Promise<Blob | undefined> {
        return Promise.resolve().then(async () => {
            const file = await this.#file(id);
            if (!file.exists) {
                return undefined;
            }
            return file;
        });
    }

    #delete(id: string): Promise<void> {
        return Promise.resolve().then(async () => {
            const file = await this.#file(id);
            if (file.exists) file.delete();
        });
    }

    #clear(): Promise<void> {
        return Promise.resolve().then(() => {
            const directory = new Directory(Paths.document, this.#directoryName);
            if (directory.exists) directory.delete();
        });
    }

    #directory(): Directory {
        const directory = new Directory(Paths.document, this.#directoryName);
        directory.create({ idempotent: true, intermediates: true });
        return directory;
    }

    #file(id: string): Promise<File> {
        return hashStorageName(id).then((name) => new File(this.#directory(), name));
    }
}
