import { Context, Effect, Layer, LayerMap, Schema } from "effect";
import { Runtime } from "./Runtime.js";
import { RuntimePartition, RuntimePartitionSchema } from "./RuntimePartition.js";
import type { RuntimeService } from "./Runtime.js";
import type { RuntimeAcquisitionError } from "./types.js";
import type { BrowserAuthentication } from "./types.js";
import type { Scope } from "effect";

/** Platform configuration supplies a Layer; partition identity is an Effect requirement. */
export type RuntimeLayer = Layer.Layer<Runtime, RuntimeAcquisitionError, RuntimePartition>;
/** Platform capabilities plus lazy partition acquisition; creating this Layer opens no storage. */
export type RuntimesLayer = Layer.Layer<Runtimes, RuntimeAcquisitionError>;

/** Scoped partition acquisition for installations that open multiple ontologies. */
export class Runtimes extends Context.Service<
    Runtimes,
    {
        readonly browserAuthentication?: BrowserAuthentication;
        readonly acquire: (
            partition: RuntimePartition["Service"]
        ) => Effect.Effect<RuntimeService, RuntimeAcquisitionError, Scope.Scope>;
    }
>()("@party-stack/runtime/Runtimes") {
    static readonly layer = (
        platform: RuntimeLayer,
        options: { readonly browserAuthentication?: BrowserAuthentication } = {}
    ) =>
        Layer.effect(
            Runtimes,
            Effect.gen(function* () {
                const codec = Schema.fromJsonString(RuntimePartitionSchema);
                const encode = Schema.encodeSync(codec);
                const decode = Schema.decodeUnknownSync(codec);
                const partitions = yield* LayerMap.make((key: string) =>
                    Layer.fresh(platform).pipe(Layer.provide(Layer.succeed(RuntimePartition)(decode(key))))
                );
                return Runtimes.of({
                    browserAuthentication: options.browserAuthentication,
                    acquire: Effect.fnUntraced(function* (partition) {
                        const context = yield* partitions.contextEffect(encode(partition));
                        return Context.get(context, Runtime);
                    }),
                });
            })
        );
}
