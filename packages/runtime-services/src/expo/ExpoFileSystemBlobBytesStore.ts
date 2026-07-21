import { Directory, File, Paths } from "expo-file-system";
import type { BlobBytesStore } from "../types.js";

export interface ExpoFileSystemBlobBytesStoreOptions {
    directoryName: string;
}

function encodeFileName(id: string): string {
    return encodeURIComponent(id);
}

function decodeFileName(name: string): string {
    return decodeURIComponent(name);
}

export class ExpoFileSystemBlobBytesStore implements BlobBytesStore {
    #directoryName: string;

    constructor(options: ExpoFileSystemBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async write(id: string, blob: Blob): Promise<void> {
        const file = this.#file(id);
        file.create({ intermediates: true, overwrite: true });
        file.write(new Uint8Array(await blob.arrayBuffer()));
    }

    read(id: string): Promise<Blob> {
        return Promise.resolve().then(() => {
            const file = this.#file(id);
            if (!file.exists) {
                throw new Error(`Blob bytes not found for "${id}".`);
            }
            return file;
        });
    }

    delete(id: string): Promise<void> {
        return Promise.resolve().then(() => {
            const file = this.#file(id);
            if (file.exists) file.delete();
        });
    }

    list(): Promise<string[]> {
        return Promise.resolve().then(() =>
            this.#directory()
                .list()
                .filter((entry): entry is File => entry instanceof File)
                .map((file) => decodeFileName(file.name))
        );
    }

    #directory(): Directory {
        const directory = new Directory(Paths.document, this.#directoryName);
        directory.create({ idempotent: true, intermediates: true });
        return directory;
    }

    #file(id: string): File {
        return new File(this.#directory(), encodeFileName(id));
    }
}
