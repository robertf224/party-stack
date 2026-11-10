import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { NativeBlob } = vi.hoisted(() => ({ NativeBlob: globalThis.Blob }));
vi.mock("expo-crypto", () => ({
    getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    randomUUID: () => "native-uuid",
}));
vi.mock("expo-blob", () => ({ Blob: class ExpoBlob extends NativeBlob {} }));

const originalBlob = globalThis.Blob;
const originalFile = globalThis.File;
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.Blob = originalBlob;
    globalThis.File = originalFile;
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
});

describe("Expo polyfill", () => {
    it("installs Expo Blob and preserves Expo's installed fetch", async () => {
        const { Blob } = await import("expo-blob");
        await import("./polyfill.js");
        expect(globalThis.Blob).toBe(Blob);
        expect(globalThis.fetch).toBe(originalFetch);
    });

    it("constructs files from Expo blobs without changing their bytes", async () => {
        await import("./polyfill.js");
        const blob = new Blob([new Uint8Array([0, 128, 255])]);
        const file = new File([blob], "attachment.bin", {
            type: "application/octet-stream",
            lastModified: 1234,
        });
        expect(file).toBeInstanceOf(Blob);
        expect(file.name).toBe("attachment.bin");
        expect(file.lastModified).toBe(1234);
        expect(file.type).toBe("application/octet-stream");
        expect(file.size).toBe(3);
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
        expect(Object.prototype.toString.call(file)).toBe("[object File]");
    });

    it("defaults file timestamps and supports blob slicing", async () => {
        vi.spyOn(Date, "now").mockReturnValue(4321);
        await import("./polyfill.js");
        const file = new File(["hello"], "hello.txt", { type: "text/plain" });
        expect(file.lastModified).toBe(4321);
        expect(file.webkitRelativePath).toBe("");
        await expect(file.slice(1, 4).text()).resolves.toBe("ell");
    });

    it("preserves a file's name through Expo FormData append and set", async () => {
        const { installFormDataPatch } = (await import(
            new URL("../node_modules/expo/src/winter/FormData.ts", import.meta.url).href
        )) as typeof import("expo/build/winter/FormData.js");
        class ReactNativeFormData {
            _parts: [string, string | Blob][] = [];
        }
        const FormData = installFormDataPatch(ReactNativeFormData as unknown as typeof globalThis.FormData);
        await import("./polyfill.js");
        const file = new File(["attachment"], "attachment.txt", { type: "text/plain" });
        const form = new FormData();
        form.append("attachment", file);
        expect(form.get("attachment")).toBe(file);
        expect(file.name).toBe("attachment.txt");
        form.set("attachment", file);
        expect(form.get("attachment")).toBe(file);
        expect(file.name).toBe("attachment.txt");
        await expect(file.text()).resolves.toBe("attachment");
    });
});

it("installs native secure randomness when the host has no Web Crypto global", async () => {
    vi.stubGlobal("crypto", undefined);
    await import("./polyfill.js");
    expect(crypto.randomUUID()).toBe("native-uuid");
    expect(crypto.getRandomValues(new Uint8Array(2))).toEqual(new Uint8Array([7, 7]));
    expect(crypto.subtle).toBeUndefined();
});
