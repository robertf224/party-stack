import { Context, Schema } from "effect";

export const RuntimePartitionSchema = Schema.Struct({
    owner: Schema.String,
    namespace: Schema.String,
});

/** Storage partition selected by the application context and ontology/installation. */
export class RuntimePartition extends Context.Service<RuntimePartition, typeof RuntimePartitionSchema.Type>()(
    "@party-stack/runtime/RuntimePartition"
) {}
