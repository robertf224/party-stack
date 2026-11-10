import { Context, Schema } from "effect";

export const RuntimePartitionSchema = Schema.Struct({
    /** Context-derived storage key, potentially combining tenant/token/user fields; not a user ID. */
    owner: Schema.String,
    namespace: Schema.String,
});

/** Storage partition selected by the application context and ontology namespace. */
export class RuntimePartition extends Context.Service<RuntimePartition, typeof RuntimePartitionSchema.Type>()(
    "@party-stack/runtime/RuntimePartition"
) {}
