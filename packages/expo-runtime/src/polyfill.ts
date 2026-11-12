import { Blob } from "expo-blob";
import { getRandomValues, randomUUID } from "expo-crypto";
import { makeTimeSlicedImmediate } from "./timeSlicedImmediate.js";

// Native AES is provided separately; only install the secure randomness used by portable IDs and nonces.
if (typeof globalThis.crypto === "undefined")
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
if (typeof globalThis.crypto.getRandomValues !== "function")
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
        value: getRandomValues,
        configurable: true,
    });
if (typeof globalThis.crypto.randomUUID !== "function")
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: randomUUID, configurable: true });

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

// RN 0.86 signals are usable by Expo fetch but lack this newer standard method;
// Foundry reads call it before HTTP. Preserve any platform implementation.
if (
    typeof globalThis.AbortSignal === "function" &&
    typeof globalThis.AbortSignal.prototype.throwIfAborted !== "function"
)
    Object.defineProperty(globalThis.AbortSignal.prototype, "throwIfAborted", {
        configurable: true,
        writable: true,
        value: function throwIfAborted(this: AbortSignal) {
            if (!this.aborted) return;
            throw (
                this.reason ?? Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
            );
        },
    });

// Expo fetch returns its own standard-tagged Response while React Native keeps a
// different global Response without Symbol.toStringTag. OAuth libraries accept
// matching standard tags across implementations; add the missing tag only.
if (
    typeof globalThis.Response === "function" &&
    Reflect.get(globalThis.Response.prototype, Symbol.toStringTag) === undefined
)
    Object.defineProperty(globalThis.Response.prototype, Symbol.toStringTag, {
        value: "Response",
        configurable: true,
    });

// React Native implements setImmediate with microtasks, so Effect fibers that
// yield through it never return to the event loop. Bound each run of immediates.
if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
    const { setImmediate, clearImmediate } = makeTimeSlicedImmediate();
    Object.defineProperty(globalThis, "setImmediate", {
        value: setImmediate,
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "clearImmediate", {
        value: clearImmediate,
        configurable: true,
        writable: true,
    });
}
