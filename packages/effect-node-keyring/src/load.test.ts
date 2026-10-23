import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { make } from "./index.js";

vi.mock("@napi-rs/keyring", () => {
    throw new Error("native-loader-private-detail");
});

test("a missing or unloadable native binary produces a safe typed acquisition error", async () => {
    const error = await Effect.runPromise(Effect.flip(make));
    expect(error).toMatchObject({ _tag: "KeyringError", operation: "load", kind: "Unavailable" });
    expect(error.message).toContain("platform binary");
    expect(JSON.stringify(error)).not.toContain("private-detail");
});
