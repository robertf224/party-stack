import { Effect, Result as EffectResult, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Temporal } from "temporal-polyfill";
import type { Encrypted as EncryptedValue } from "../utils/values.js";

/** Validate only the handle. Parsing a record never decrypts its protected value. */
export function Encrypted<A, AI>(
    _plaintext: Schema.Codec<A, AI>
): Schema.Codec<EncryptedValue<A>, EncryptedValue<AI>> {
    return Schema.Struct({
        id: Schema.String,
        source: Schema.optional(
            Schema.Struct({
                objectType: Schema.String,
                primaryKey: Schema.Union([Schema.String, Schema.Finite]),
                property: Schema.String,
            })
        ),
    });
}

/** Portable ontology results on the encoded side, Effect Result values on the type side. */
export function Result<A, AI, E, EI, RD = never, RE = never>(
    success: Schema.Codec<A, AI, RD, RE>,
    failure: Schema.Codec<E, EI, RD, RE>
) {
    return Schema.Union([
        Schema.Struct({ kind: Schema.Literal("ok"), value: success }),
        Schema.Struct({ kind: Schema.Literal("err"), value: failure }),
    ]).pipe(
        Schema.decodeTo(
            Schema.Result(Schema.toType(success), Schema.toType(failure)),
            SchemaTransformation.transform({
                decode: (value): EffectResult.Result<A, E> =>
                    value.kind === "ok" ? EffectResult.succeed(value.value) : EffectResult.fail(value.value),
                encode: (value) =>
                    EffectResult.isSuccess(value)
                        ? { kind: "ok" as const, value: value.success }
                        : { kind: "err" as const, value: value.failure },
            })
        )
    );
}

/** In-memory Temporal values; derive their ISO string representation with Schema.toCodecJson. */
export const TemporalDate = Schema.instanceOf(Temporal.PlainDate, {
    expected: "Temporal.PlainDate",
    toCodecJson: () =>
        Schema.link<Temporal.PlainDate>()(
            Schema.String,
            SchemaTransformation.transformEffect({
                decode: (value, options) =>
                    Effect.try({
                        try: () => Temporal.PlainDate.from(value, { overflow: "reject" }),
                        catch: () =>
                            new SchemaIssue.InvalidValue(
                                { expected: "an ISO Temporal date" },
                                value,
                                options
                            ),
                    }),
                encode: (value) => Effect.succeed(value.toString()),
            })
        ),
});

export const TemporalTimestamp = Schema.instanceOf(Temporal.Instant, {
    expected: "Temporal.Instant",
    toCodecJson: () =>
        Schema.link<Temporal.Instant>()(
            Schema.String,
            SchemaTransformation.transformEffect({
                decode: (value, options) =>
                    Effect.try({
                        try: () => Temporal.Instant.from(value),
                        catch: () =>
                            new SchemaIssue.InvalidValue(
                                { expected: "an ISO Temporal timestamp with an offset" },
                                value,
                                options
                            ),
                    }),
                encode: (value) => Effect.succeed(value.toString()),
            })
        ),
});
