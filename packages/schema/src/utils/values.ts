import type { Temporal } from "temporal-polyfill";

export type integer = number;

export type float = number;

export type double = number;

export type geopoint = { lat: double; lon: double };

export type date = Temporal.PlainDate;

export type timestamp = Temporal.Instant;

// TODO: revisit this (https://valinor-enterprises.slack.com/archives/C08549X3VDM/p1776138662547679)
export type attachment = {
    id: string;
    metadata: () => Promise<Pick<Blob, "size" | "type">>;
    blob: () => Promise<Blob>;
};

export type Union<T extends Record<string, unknown>> = {
    [K in keyof T]: { kind: K; value: T[K] };
}[keyof T];

export type Result<T, E> = Union<{ ok: T; err: E }>;
