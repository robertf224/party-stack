import { GeolocationError } from "@party-stack/runtime";
import { Cause, Effect, Queue, Stream } from "effect";
import type { Geolocation, GeolocationPosition } from "@party-stack/runtime";

const reasons = { 1: "PermissionDenied", 2: "PositionUnavailable", 3: "Timeout" } as const;
const messages = {
    PermissionDenied: "Location permission was denied.",
    PositionUnavailable: "Your location isn't available right now.",
    Timeout: "Finding your location timed out.",
} as const;

// Codes are read numerically: shims and polyfills often omit the error's code
// constants, and an unrecognized code must still fail rather than never settle.
const fromBrowser = (error: { readonly code?: number }) => {
    const reason = reasons[error.code as keyof typeof reasons] ?? "PositionUnavailable";
    return new GeolocationError({ reason, message: messages[reason], cause: error });
};
const copy = (position: GeolocationPosition): GeolocationPosition => ({
    coords: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude ?? null,
        altitudeAccuracy: position.coords.altitudeAccuracy ?? null,
        heading: position.coords.heading ?? null,
        speed: position.coords.speed ?? null,
    },
    timestamp: position.timestamp,
});

/** `navigator.geolocation` as the runtime capability. Undefined where the platform
 * has none, such as a worker. */
export function createWebGeolocation(): Geolocation | undefined {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return undefined;
    const geolocation = navigator.geolocation;
    return {
        getCurrentPosition: (options) =>
            Effect.callback<GeolocationPosition, GeolocationError>((resume) => {
                geolocation.getCurrentPosition(
                    (position) => resume(Effect.succeed(copy(position))),
                    (error) => resume(Effect.fail(fromBrowser(error))),
                    options
                );
            }),
        watchPosition: (options) =>
            Stream.callback<GeolocationPosition, GeolocationError>((queue) =>
                Effect.acquireRelease(
                    Effect.sync(() =>
                        geolocation.watchPosition(
                            (position) => {
                                Queue.offerUnsafe(queue, copy(position));
                            },
                            (error) => {
                                Queue.failCauseUnsafe(queue, Cause.fail(fromBrowser(error)));
                            },
                            options
                        )
                    ),
                    (id) => Effect.sync(() => geolocation.clearWatch(id))
                )
            ),
    };
}
