import { Directory, File, Paths } from "expo-file-system";
import { hashStorageName } from "./hashStorageName.js";
import type { BlobBytesStore } from "@party-stack/runtime";

export interface ExpoFileSystemBlobBytesStoreOptions {
    directoryName: string;
}

export class ExpoFileSystemBlobBytesStore implements BlobBytesStore {
    #directoryName: string;

    constructor(options: ExpoFileSystemBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async write(id: string, blob: Blob): Promise<void> {
        const file = await this.#file(id);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        file.create({ intermediates: true, overwrite: true });
        file.write(bytes);
    }

    read(id: string): Promise<Blob> {
        return Promise.resolve().then(async () => {
            const file = await this.#file(id);
            if (!file.exists) {
                throw new Error(`Blob bytes not found for "${id}".`);
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
