import { Schema } from "effect";
import type { Effect, Stream } from "effect";

/** Why a position could not be read, matching the web Geolocation API's codes:
 * `PermissionDenied` (the user or the platform refused location access),
 * `PositionUnavailable` (no fix, e.g. Location Services are off) and `Timeout`. */
export class GeolocationError extends Schema.TaggedError<GeolocationError>()("GeolocationError", {
    reason: Schema.Literals(["PermissionDenied", "PositionUnavailable", "Timeout"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
}) {}

/** A position fix. Structurally compatible with the web `GeolocationPosition`. */
export interface GeolocationPosition {
    readonly coords: {
        readonly latitude: number;
        readonly longitude: number;
        /** Meters, at 95% confidence. */
        readonly accuracy: number;
        readonly altitude: number | null;
        readonly altitudeAccuracy: number | null;
        readonly heading: number | null;
        readonly speed: number | null;
    };
    /** Milliseconds since the epoch when the fix was taken. */
    readonly timestamp: number;
}

/** The web `PositionOptions`, honored where the platform supports them. */
export interface GeolocationOptions {
    readonly enableHighAccuracy?: boolean;
    /** Milliseconds to wait for a fix before failing with `Timeout`. */
    readonly timeout?: number;
    /** Accept a cached fix at most this many milliseconds old. */
    readonly maximumAge?: number;
}

/** Device location, provided by a platform runtime that supports it. */
export interface Geolocation {
    readonly getCurrentPosition: (
        options?: GeolocationOptions
    ) => Effect.Effect<GeolocationPosition, GeolocationError>;
    /** Positions as they change, starting with the current one. */
    readonly watchPosition: (
        options?: GeolocationOptions
    ) => Stream.Stream<GeolocationPosition, GeolocationError>;
}

/** The web API's numeric error codes, for code that bridges to `navigator.geolocation`. */
export const geolocationErrorCode = (reason: GeolocationError["reason"]): 1 | 2 | 3 =>
    reason === "PermissionDenied" ? 1 : reason === "PositionUnavailable" ? 2 : 3;
