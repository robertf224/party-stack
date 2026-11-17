import { GeolocationError } from "@party-stack/runtime";
import { Cause, Effect, Option, Queue, Stream } from "effect";
import * as ExpoLocation from "expo-location";
import type { Geolocation, GeolocationOptions, GeolocationPosition } from "@party-stack/runtime";

interface ExpoLocationObject {
    readonly coords: {
        readonly latitude: number;
        readonly longitude: number;
        readonly accuracy: number | null;
        readonly altitude: number | null;
        readonly altitudeAccuracy: number | null;
        readonly heading: number | null;
        readonly speed: number | null;
    };
    readonly timestamp: number;
}

/** The parts of `expo-location` this uses; tests pass a fake. */
export interface ExpoLocationModule {
    readonly requestForegroundPermissionsAsync: () => Promise<{ readonly status: string }>;
    readonly getCurrentPositionAsync: (options?: { accuracy?: number }) => Promise<ExpoLocationObject>;
    readonly getLastKnownPositionAsync: (options?: {
        maxAge?: number;
        requiredAccuracy?: number;
    }) => Promise<ExpoLocationObject | null>;
    readonly watchPositionAsync: (
        options: { accuracy?: number },
        callback: (location: ExpoLocationObject) => void,
        errorHandler?: (reason: string) => void
    ) => Promise<{ remove(): void }>;
    readonly Accuracy: { readonly Balanced: number; readonly High: number };
}

/** A recent cached fix is better than failing when GPS can't produce a new one. */
const lastKnownMaxAgeMs = 5 * 60_000;
const lastKnownRequiredAccuracyM = 1_000;

const fail = (reason: GeolocationError["reason"], message: string, cause?: unknown) =>
    new GeolocationError({ reason, message, cause });
const toPosition = ({ coords, timestamp }: ExpoLocationObject): GeolocationPosition => ({
    coords: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy ?? 0,
        altitude: coords.altitude,
        altitudeAccuracy: coords.altitudeAccuracy,
        heading: coords.heading,
        speed: coords.speed,
    },
    timestamp,
});

/** Device location through expo-location, with the web API's options and reasons. */
export function createExpoGeolocation(location: ExpoLocationModule = ExpoLocation): Geolocation {
    const permitted = Effect.tryPromise({
        try: () => location.requestForegroundPermissionsAsync(),
        catch: (cause) => fail("PermissionDenied", "Location permission could not be requested.", cause),
    }).pipe(
        Effect.flatMap((permission) =>
            permission.status === "granted"
                ? Effect.void
                : Effect.fail(fail("PermissionDenied", "Location permission was denied."))
        )
    );
    const accuracy = (options?: GeolocationOptions) =>
        options?.enableHighAccuracy ? location.Accuracy.High : location.Accuracy.Balanced;
    const lastKnown = (options?: GeolocationOptions) =>
        Effect.tryPromise(() =>
            location.getLastKnownPositionAsync({
                maxAge: options?.maximumAge ?? lastKnownMaxAgeMs,
                requiredAccuracy: lastKnownRequiredAccuracyM,
            })
        ).pipe(
            Effect.map((value) => Option.fromNullishOr(value)),
            Effect.orElseSucceed(() => Option.none<ExpoLocationObject>())
        );
    return {
        getCurrentPosition: (options) =>
            Effect.gen(function* () {
                yield* permitted;
                const current = Effect.tryPromise({
                    try: () => location.getCurrentPositionAsync({ accuracy: accuracy(options) }),
                    catch: (cause) =>
                        fail("PositionUnavailable", "Your location isn't available right now.", cause),
                });
                const timeout = options?.timeout;
                const result = yield* Effect.result(
                    timeout !== undefined && Number.isFinite(timeout)
                        ? current.pipe(
                              Effect.timeoutOrElse({
                                  duration: timeout,
                                  orElse: () =>
                                      Effect.fail(fail("Timeout", "Finding your location timed out.")),
                              })
                          )
                        : current
                );
                if (result._tag === "Success") return toPosition(result.success);
                const cached = yield* lastKnown(options);
                if (Option.isSome(cached)) return toPosition(cached.value);
                return yield* result.failure;
            }),
        watchPosition: (options) =>
            Stream.unwrap(
                Effect.as(
                    permitted,
                    Stream.callback<GeolocationPosition, GeolocationError>((queue) =>
                        Effect.acquireRelease(
                            Effect.tryPromise({
                                try: () =>
                                    location.watchPositionAsync(
                                        { accuracy: accuracy(options) },
                                        (value) => {
                                            Queue.offerUnsafe(queue, toPosition(value));
                                        },
                                        (reason) => {
                                            Queue.failCauseUnsafe(
                                                queue,
                                                Cause.fail(
                                                    fail(
                                                        "PositionUnavailable",
                                                        "Your location isn't available right now.",
                                                        reason
                                                    )
                                                )
                                            );
                                        }
                                    ),
                                catch: (cause) =>
                                    fail(
                                        "PositionUnavailable",
                                        "Your location isn't available right now.",
                                        cause
                                    ),
                            }),
                            (subscription) => Effect.sync(() => subscription.remove())
                        )
                    )
                )
            ),
    };
}
