import { Effect, Fiber, Result, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vite-plus/test";
import { createExpoGeolocation, type ExpoLocationModule } from "./createExpoGeolocation.js";

// The native module is not available under Node; each test passes a fake instead.
vi.mock("expo-location", () => ({ Accuracy: { Balanced: 3, High: 4 } }));

const fix = (latitude: number, accuracy: number | null = 10) => ({
    coords: {
        latitude,
        longitude: 2,
        accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
    },
    timestamp: 5,
});
const fake = (overrides: Partial<ExpoLocationModule> = {}): ExpoLocationModule => ({
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
    getCurrentPositionAsync: vi.fn(async () => fix(1)),
    getLastKnownPositionAsync: vi.fn(async () => null),
    watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
    Accuracy: { Balanced: 3, High: 4 },
    ...overrides,
});
const failure = (effect: Effect.Effect<unknown, { reason: string }>) =>
    Effect.runPromise(Effect.result(effect)).then(
        (result) => Result.isFailure(result) && result.failure.reason
    );

test("expo geolocation reads a fix at the requested accuracy", async () => {
    const location = fake();
    const geolocation = createExpoGeolocation(location);
    expect(await Effect.runPromise(geolocation.getCurrentPosition())).toEqual({
        coords: {
            latitude: 1,
            longitude: 2,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
        },
        timestamp: 5,
    });
    await Effect.runPromise(geolocation.getCurrentPosition({ enableHighAccuracy: true }));
    expect(location.getCurrentPositionAsync).toHaveBeenLastCalledWith({ accuracy: 4 });
});

test("a denied permission is PermissionDenied and reads nothing", async () => {
    const location = fake({ requestForegroundPermissionsAsync: async () => ({ status: "denied" }) });
    expect(await failure(createExpoGeolocation(location).getCurrentPosition())).toBe("PermissionDenied");
    expect(location.getCurrentPositionAsync).not.toHaveBeenCalled();
});

test("without a fresh fix it falls back to a recent one, else reports why", async () => {
    const noFix = { getCurrentPositionAsync: async () => Promise.reject(new Error("GPS off")) };
    expect(
        (
            await Effect.runPromise(
                createExpoGeolocation(
                    fake({ ...noFix, getLastKnownPositionAsync: async () => fix(7) })
                ).getCurrentPosition()
            )
        ).coords.latitude
    ).toBe(7);
    expect(await failure(createExpoGeolocation(fake(noFix)).getCurrentPosition())).toBe(
        "PositionUnavailable"
    );
});

test("a fix slower than the timeout is a Timeout", async () => {
    const geolocation = createExpoGeolocation(fake({ getCurrentPositionAsync: () => new Promise(() => {}) }));
    await Effect.runPromise(
        Effect.gen(function* () {
            const read = yield* Effect.result(geolocation.getCurrentPosition({ timeout: 1_000 })).pipe(
                Effect.forkChild
            );
            yield* TestClock.adjust(1_000);
            const result = yield* Fiber.join(read);
            expect(Result.isFailure(result) && result.failure.reason).toBe("Timeout");
        }).pipe(Effect.provide(TestClock.layer()))
    );
});

test("watching streams positions and stops the subscription when done", async () => {
    const remove = vi.fn();
    const location = fake({
        watchPositionAsync: async (_options, callback) => {
            callback(fix(1));
            callback(fix(2));
            return { remove };
        },
    });
    const positions = await Effect.runPromise(
        Stream.runCollect(Stream.take(createExpoGeolocation(location).watchPosition(), 2))
    );
    expect(Array.from(positions).map((position) => position.coords.latitude)).toEqual([1, 2]);
    expect(remove).toHaveBeenCalledOnce();
});
