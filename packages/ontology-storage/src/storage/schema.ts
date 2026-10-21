import { Schema } from "effect";
import { FieldSchema } from "../query/schema.js";
/** Validate persisted metadata before the planner or schema-version guard uses it. */
export const StoredIndexSchema = Schema.Struct({
    name: Schema.String,
    field: FieldSchema,
    unique: Schema.optional(Schema.Boolean),
    multiEntry: Schema.optional(Schema.Boolean),
    table: Schema.String,
    version: Schema.Int,
});
