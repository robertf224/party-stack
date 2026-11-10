import { Effect, Fiber } from "effect";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createExpoBrowserAuthentication } from "./createExpoBrowserAuthentication.js";
const native = vi.hoisted(() => ({ open: vi.fn(), dismiss: vi.fn() }));
vi.mock("expo-web-browser", () => ({
    openAuthSessionAsync: native.open,
    dismissAuthSession: native.dismiss,
}));
beforeEach(() => vi.resetAllMocks());

test("Expo auth is scoped and returns the SDK callback", async () => {
    native.open.mockResolvedValue({ type: "success", url: "app://callback?code=fixture" });
    const result = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* createExpoBrowserAuthentication().start({
                    redirectUrl: "app://callback",
                });
                return yield* session.open("https://provider.example/authorize");
            })
        )
    );
    expect(result.callbackUrl).toBe("app://callback?code=fixture");
    expect(native.dismiss).toHaveBeenCalledOnce();
});
test("interrupting Expo authorization dismisses the native session once", async () => {
    native.open.mockImplementation(() => new Promise(() => {}));
    const fiber = Effect.runFork(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* createExpoBrowserAuthentication().start({
                    redirectUrl: "app://callback",
                });
                return yield* session.open("https://provider.example/authorize");
            })
        )
    );
    expect(native.open).toHaveBeenCalledOnce();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(native.dismiss).toHaveBeenCalledOnce();
});
test("native user cancellation is an expected authentication error", async () => {
    native.open.mockResolvedValue({ type: "cancel" });
    await expect(
        Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const session = yield* createExpoBrowserAuthentication().start({
                        redirectUrl: "app://callback",
                    });
                    return yield* session.open("https://provider.example/authorize");
                })
            )
        )
    ).rejects.toMatchObject({ _tag: "BrowserAuthenticationError", reason: "Cancelled" });
});
