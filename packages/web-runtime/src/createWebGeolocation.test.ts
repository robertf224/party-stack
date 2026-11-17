import { Effect, Result } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createWebGeolocation } from "./createWebGeolocation.js";

afterEach(() => vi.unstubAllGlobals());
const position = {
    coords: {
        latitude: 51.5,
        longitude: -0.12,
        accuracy: 12,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
    },
    timestamp: 1,
};
const stubGeolocation = (outcome: { position?: typeof position; code?: 1 | 2 | 3 }) =>
    vi.stubGlobal("navigator", {
        geolocation: {
            getCurrentPosition: (
                success: (value: typeof position) => void,
                failure: (error: { code: number; message: string }) => void
            ) =>
                outcome.position
                    ? success(outcome.position)
                    : failure({ code: outcome.code!, message: "no" }),
            watchPosition: () => 1,
            clearWatch: () => undefined,
        },
    });

test("web geolocation is absent where the platform has none", () => {
    vi.stubGlobal("navigator", {});
    expect(createWebGeolocation()).toBeUndefined();
});

test("web geolocation reads a position and reports each failure by reason", async () => {
    stubGeolocation({ position });
    expect(await Effect.runPromise(createWebGeolocation()!.getCurrentPosition())).toEqual(position);
    for (const [code, reason] of [
        [1, "PermissionDenied"],
        [2, "PositionUnavailable"],
        [3, "Timeout"],
    ] as const) {
        stubGeolocation({ code });
        const result = await Effect.runPromise(Effect.result(createWebGeolocation()!.getCurrentPosition()));
        expect(Result.isFailure(result) && result.failure).toMatchObject({
            _tag: "GeolocationError",
            reason,
        });
    }
});

test("web geolocation fails, rather than hangs, on an error code it does not know", async () => {
    stubGeolocation({ code: 9 as never });
    const result = await Effect.runPromise(Effect.result(createWebGeolocation()!.getCurrentPosition()));
    expect(Result.isFailure(result) && result.failure.reason).toBe("PositionUnavailable");
});
