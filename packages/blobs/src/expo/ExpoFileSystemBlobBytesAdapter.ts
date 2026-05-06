import { Directory, File, Paths } from "expo-file-system";
import type { BlobBytesAdapter } from "../types.js";

export interface ExpoFileSystemBlobBytesAdapterOptions {
    directoryName?: string;
    rootDirectory?: Directory;
}

function encodeFileName(id: string): string {
    return encodeURIComponent(id);
}

function decodeFileName(name: string): string {
    return decodeURIComponent(name);
}

export class ExpoFileSystemBlobBytesAdapter implements BlobBytesAdapter {
    readonly directoryName: string;
    readonly rootDirectory: Directory;

    constructor(opts: ExpoFileSystemBlobBytesAdapterOptions = {}) {
        this.directoryName = opts.directoryName ?? "party-stack-blobs";
        this.rootDirectory = opts.rootDirectory ?? Paths.document;
    }

    private directory(): Directory {
        const directory = new Directory(this.rootDirectory, this.directoryName);
        directory.create({ idempotent: true, intermediates: true });
        return directory;
    }

    private file(id: string): File {
        return new File(this.directory(), encodeFileName(id));
    }

    async write(id: string, blob: Blob): Promise<void> {
        const file = this.file(id);
        file.create({ intermediates: true, overwrite: true });
        file.write(new Uint8Array(await blob.arrayBuffer()));
    }

    read(id: string): Promise<Blob> {
        return Promise.resolve().then(() => {
            const file = this.file(id);
            if (!file.exists) {
                throw new Error(`Blob bytes not found for "${id}".`);
            }
            return file;
        });
    }

    delete(id: string): Promise<void> {
        return Promise.resolve().then(() => {
            const file = this.file(id);
            if (file.exists) {
                file.delete();
            }
        });
    }

    list(): Promise<string[]> {
        return Promise.resolve().then(() =>
            this.directory()
                .list()
                .filter((entry): entry is File => entry instanceof File)
                .map((file) => decodeFileName(file.name))
        );
    }
}
