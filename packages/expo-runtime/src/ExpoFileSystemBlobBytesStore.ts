import {
    BlobBytesNotFoundError,
    byteSource,
    type ByteInput,
    type BlobBytesStore,
} from "@party-stack/runtime";
import { Stream } from "effect";
import { Directory, File, Paths } from "expo-file-system";
import { hashStorageName } from "./hashStorageName.js";

export interface ExpoFileSystemBlobBytesStoreOptions {
    directoryName: string;
}

export class ExpoFileSystemBlobBytesStore implements BlobBytesStore {
    #directoryName: string;

    constructor(options: ExpoFileSystemBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async write(id: string, input: ByteInput, signal?: AbortSignal): Promise<void> {
        const file = await this.#file(id);
        file.create({ intermediates: true, overwrite: true });
        try {
            await Stream.toReadableStream(byteSource(input).stream).pipeTo(file.writableStream(), { signal });
        } catch (error) {
            if (file.exists) file.delete();
            throw error;
        }
    }

    read(id: string): Promise<Blob> {
        return Promise.resolve().then(async () => {
            const file = await this.#file(id);
            if (!file.exists) {
                throw new BlobBytesNotFoundError(id);
            }
            return file;
        });
    }

    delete(id: string): Promise<void> {
        return Promise.resolve().then(async () => {
            const file = await this.#file(id);
            if (file.exists) file.delete();
        });
    }

    clear(): Promise<void> {
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
