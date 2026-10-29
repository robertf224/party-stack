import { Cause, Context, Effect, Exit, Option, Predicate, Tracer } from "effect";

export interface TraceEvent {
    readonly name: string;
    readonly at: number;
    readonly attributes: Readonly<Record<string, string | number | boolean>>;
}
export interface TraceRecord {
    readonly id: string;
    readonly traceId: string;
    readonly parentId?: string;
    readonly name: string;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly outcome: "running" | "success" | "failure" | "interrupted";
    readonly error?: { readonly kind: "Error" | "Defect"; readonly message: string };
    readonly attributes: Readonly<Record<string, string | number | boolean>>;
    readonly events?: readonly TraceEvent[];
    readonly eventCount?: number;
}
export interface TraceStore {
    readonly getSnapshot: () => readonly TraceRecord[];
    readonly subscribe: (listener: (record?: TraceRecord) => void) => () => void;
    readonly clear: () => void;
}
/** Bounded Effect spans and error messages; no stacks, error payloads, or arbitrary attributes. */
export function createTraceCapture(capacity = 500, upstream?: Tracer.Tracer, history = true) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
        throw new RangeError("Trace capacity must be positive.");
    const exporter = upstream === Tracer.nativeTracer ? undefined : upstream;
    const allowed = new Set([
        "objectType",
        "operation",
        "count",
        "revision",
        "state",
        "db.system.name",
        "activity",
    ]);
    let records: readonly TraceRecord[] = [];
    let generation = 0;
    const listeners = new Set<(record?: TraceRecord) => void>();
    const changed = (record?: TraceRecord) => {
        for (const listener of listeners) {
            try {
                listener(record);
            } catch {
                /* Observers cannot fail an operation. */
            }
        }
    };
    const tracer = Tracer.make({
        context: exporter?.context?.bind(exporter),
        span(options) {
            const span = exporter ? exporter.span(options) : new Tracer.NativeSpan(options);
            if (!options.sampled) return span;
            const spanGeneration = generation;
            const initial: TraceRecord = {
                id: span.spanId,
                traceId: span.traceId,
                parentId: Option.getOrUndefined(span.parent)?.spanId,
                name: span.name,
                startedAt: Number(options.startTime / 1000n) / 1000,
                durationMs: 0,
                outcome: "running",
                attributes: {},
            };
            let current = initial;
            let ended = false;
            const publish = () => {
                if (generation !== spanGeneration) return;
                const index = records.findIndex(
                    (record) => record.id === span.spanId && record.traceId === span.traceId
                );
                if (history)
                    records =
                        index < 0
                            ? [...records.slice(Math.max(0, records.length - capacity + 1)), current]
                            : records.map((record, at) => (at === index ? current : record));
                changed(current);
            };
            const safeAttributes = (entries: Iterable<readonly [string, unknown]>) => {
                const result: Record<string, string | number | boolean> = {};
                for (const [key, value] of entries)
                    if (
                        allowed.has(key) &&
                        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
                    )
                        result[key] = value;
                return result;
            };
            publish();
            const attribute = span.attribute.bind(span);
            span.attribute = (key, value) => {
                attribute(key, value);
                if (!ended && allowed.has(key)) {
                    current = { ...current, attributes: safeAttributes(span.attributes) };
                    publish();
                }
            };
            // Producers explicitly opt diagnostic events in; platform code knows no domain event names.
            const event = exporter ? span.event.bind(span) : undefined;
            span.event = (name, time, attributes = {}) => {
                event?.(name, time, attributes);
                if (ended || attributes.diagnostic !== true) return;
                current = {
                    ...current,
                    events: [
                        ...(current.events ?? []).slice(-99),
                        {
                            name,
                            at: Number(time) / 1_000_000,
                            attributes: safeAttributes(Object.entries(attributes)),
                        },
                    ],
                    eventCount: (current.eventCount ?? 0) + 1,
                };
                publish();
            };
            const end = span.end.bind(span);
            span.end = (time, exit) => {
                end(time, exit);
                if (ended) return;
                ended = true;
                const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
                let error: TraceRecord["error"];
                if (Exit.isFailure(exit) && !interrupted) {
                    const reason =
                        exit.cause.reasons.find(Cause.isFailReason) ??
                        exit.cause.reasons.find(Cause.isDieReason);
                    const value = reason?._tag === "Fail" ? reason.error : reason?.defect;
                    let message = "Error details were not recorded.";
                    try {
                        const candidate = Predicate.isError(value) ? value.message : value;
                        if (Predicate.isString(candidate)) message = candidate;
                    } catch {
                        /* A diagnostic must not fail while inspecting a custom error. */
                    }
                    error = {
                        kind: reason?._tag === "Die" ? "Defect" : "Error",
                        message: message.slice(0, 500) || "No error message provided.",
                    };
                }
                current = {
                    ...current,
                    durationMs: Number(time - options.startTime) / 1_000_000,
                    outcome: Exit.isSuccess(exit) ? "success" : interrupted ? "interrupted" : "failure",
                    ...(error ? { error } : {}),
                    attributes: safeAttributes(span.attributes),
                };
                publish();
            };
            return span;
        },
    });
    return {
        tracer,
        getSnapshot: () => records,
        subscribe: (listener: (record?: TraceRecord) => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        clear: () => {
            generation++;
            records = [];
            changed();
        },
    };
}
export type TraceCapture = ReturnType<typeof createTraceCapture>;

/** Diagnostics configuration is independent of platform Runtime acquisition. */
export type TraceRecordingMode = false | "buffer" | "live";
export const TraceRecording = Context.Reference<TraceRecordingMode>(
    "@party-stack/runtime/tracing/TraceRecording",
    { defaultValue: () => false }
);

/** Capture alongside the configured Effect tracer; production recording is opt-in. */
export const makeTraceCapture = Effect.fnUntraced(function* (mode?: TraceRecordingMode) {
    const recording = mode ?? (yield* TraceRecording);
    if (!recording) return undefined;
    return createTraceCapture(500, yield* Tracer.Tracer, recording === "buffer");
});
