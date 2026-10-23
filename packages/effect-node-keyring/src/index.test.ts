import { Effect, Fiber, Redacted } from "effect";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { make, NodeKeyring } from "./index.js";

const native = vi.hoisted(() => ({
    entries: new Map<string, string | Uint8Array>(),
    constructors: vi.fn(),
    fail: false,
    wait: false,
    signals: [] as AbortSignal[],
}));
vi.mock("@napi-rs/keyring", () => ({
    AsyncEntry: class {
        key: string;
        constructor(service: string, account: string, options: unknown) {
            native.constructors(service, account, options);
            this.key = JSON.stringify([service, account]);
            if (native.fail) throw new Error("private-native-error");
        }
        async getPassword(signal: AbortSignal) {
            native.signals.push(signal);
            if (native.wait)
                return new Promise<string | null>((_, reject) =>
                    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
                );
            return (native.entries.get(this.key) as string | undefined) ?? null;
        }
        async setPassword(value: string, signal: AbortSignal) {
            native.signals.push(signal);
            native.entries.set(this.key, value);
        }
        async getSecret() {
            const value = native.entries.get(this.key);
            return value ? [...(value as Uint8Array)] : null;
        }
        async setSecret(value: Uint8Array) {
            native.entries.set(this.key, new Uint8Array(value));
        }
        async deleteCredential() {
            return native.entries.delete(this.key);
        }
    },
}));
beforeEach(() => {
    native.entries.clear();
    native.fail = false;
    native.wait = false;
    native.signals = [];
    vi.clearAllMocks();
});

test("uses async native storage, redacts passwords and requires persistent Linux Secret Service", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const keyring = yield* make;
            expect(native.constructors).not.toHaveBeenCalled();
            expect(yield* keyring.getPassword("app", "account")).toBeUndefined();
            yield* keyring.setPassword("app", "account", Redacted.make("private-password"));
            const value = (yield* keyring.getPassword("app", "account"))!;
            expect(Redacted.value(value)).toBe("private-password");
            expect(JSON.stringify(value)).not.toContain("private-password");
            expect(native.constructors).toHaveBeenCalledWith("app", "account", {
                linux: { store: "secret-service" },
            });
            expect(yield* keyring.deleteCredential("app", "account")).toBe(true);
            expect(yield* keyring.deleteCredential("app", "account")).toBe(false);
            expect(native.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        })
    );
});

test("supports binary keys and service/account isolation through a Layer", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const keyring = yield* NodeKeyring;
            yield* keyring.setSecret("app", "key", Redacted.make(new Uint8Array([1, 2, 3])));
            expect(Redacted.value((yield* keyring.getSecret("app", "key"))!)).toEqual(
                new Uint8Array([1, 2, 3])
            );
            expect(yield* keyring.getSecret("other", "key")).toBeUndefined();
            expect(yield* keyring.getSecret("app", "other")).toBeUndefined();
        }).pipe(Effect.provide(NodeKeyring.layer))
    );
});

test("native failures remain typed errors without identifiers or secret-bearing native causes", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const keyring = yield* make;
            native.fail = true;
            const error = yield* keyring
                .setPassword("private-service", "private-account", Redacted.make("private-password"))
                .pipe(Effect.flip);
            expect(error).toMatchObject({ _tag: "KeyringError", operation: "set", kind: "OperationFailed" });
            expect(JSON.stringify(error)).not.toContain("private-");
        })
    );
});

test("fiber interruption reaches the native operation's AbortSignal", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const keyring = yield* make;
            native.wait = true;
            const fiber = yield* Effect.forkChild(keyring.getPassword("app", "account"));
            yield* Effect.promise(() => vi.waitFor(() => expect(native.signals).toHaveLength(1)));
            yield* Fiber.interrupt(fiber);
            expect(native.signals[0]!.aborted).toBe(true);
        })
    );
});
