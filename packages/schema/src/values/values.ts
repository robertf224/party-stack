import type { Temporal } from "temporal-polyfill";

export type integer = number;

export type float = number;

export type double = number;

export type geopoint = { lat: double; lon: double };

export type date = Temporal.PlainDate;

export type timestamp = Temporal.Instant;

export type Union<T extends Record<string, unknown>> = {
    [K in keyof T]: { kind: K; value: T[K] };
}[keyof T];

export type Result<T, E> = Union<{ ok: T; err: E }>;
