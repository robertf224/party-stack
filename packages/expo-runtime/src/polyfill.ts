import { Blob } from "expo-blob";

// Expo declarations predate the current DOM Blob byte-array generics.
globalThis.Blob = Blob as unknown as typeof globalThis.Blob;

// React Native File extends its own Blob class, so replace it alongside Blob.
class ExpoFile extends globalThis.Blob implements File {
    readonly #name: string;
    readonly #lastModified: number;

    constructor(parts: BlobPart[], name: string, options: FilePropertyBag = {}) {
        super(parts, options);
        this.#name = String(name);
        this.#lastModified = options.lastModified ?? Date.now();
        // Expo FormData checks own descriptors before assigning a blob filename.
        // An inherited getter alone would make that assignment throw.
        Object.defineProperty(this, "name", { value: this.#name, enumerable: true });
    }

    get name(): string {
        return this.#name;
    }

    get lastModified(): number {
        return this.#lastModified;
    }

    get webkitRelativePath(): string {
        return "";
    }

    get [Symbol.toStringTag](): string {
        return "File";
    }
}

globalThis.File = ExpoFile;
