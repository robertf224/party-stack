import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcSerialization } from "effect/rpc";

// The worker channel uses structured clone. JSON derivation would reject
// undefined, bigint and the existing codec's native cloneable values.
const structuredCloneCodec: RpcSerialization.CodecFor = Schema.toCodecIso;
export const withStructuredCloneCodec = <P extends { readonly codecFor: RpcSerialization.CodecFor }>(
    protocol: P
): P => ({
    ...protocol,
    codecFor: structuredCloneCodec,
});

export const RpcError = Schema.Struct({
    name: Schema.String,
    message: Schema.String,
    code: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const Identity = {
    version: Schema.Int,
    scope: Schema.String,
    connectionId: Schema.String,
};

export const CoordinationRpcs = RpcGroup.make(
    Rpc.make("Hello", { payload: Identity, error: RpcError }),
    Rpc.make("Call", {
        payload: {
            ...Identity,
            service: Schema.String,
            method: Schema.String,
            payload: Schema.Unknown,
        },
        success: Schema.Unknown,
        error: RpcError,
    }),
    Rpc.make("Events", {
        payload: Identity,
        success: Schema.Struct({ service: Schema.String, event: Schema.String, payload: Schema.Unknown }),
        error: RpcError,
        stream: true,
    })
);

export type CoordinationRpcEvent = {
    readonly service: string;
    readonly event: string;
    readonly payload: unknown;
};
