import { Schema } from "effect";

export const FieldSchema = Schema.Struct({
    _tag: Schema.Literal("Field"),
    path: Schema.Array(Schema.String),
});
export const isField = Schema.is(FieldSchema);
export const IndexSchema = Schema.Struct({
    name: Schema.String,
    field: FieldSchema,
    unique: Schema.optional(Schema.Boolean),
    multiEntry: Schema.optional(Schema.Boolean),
    size: Schema.optional(Schema.Boolean),
});
// Shape validation whitelists ordering tokens; `validateFilter` whitelists every
// filter operator and operand before the planner or a SQL compiler sees it.
export const QueryShape = Schema.Struct({
    where: Schema.optional(Schema.Unknown),
    orderBy: Schema.optional(
        Schema.Array(
            Schema.Struct({
                field: FieldSchema,
                direction: Schema.optional(Schema.Literals(["asc", "desc"])),
                nulls: Schema.optional(Schema.Literals(["first", "last"])),
            })
        )
    ),
    limit: Schema.optional(Schema.Number),
    offset: Schema.optional(Schema.Number),
    after: Schema.optional(
        Schema.Struct({
            key: Schema.Union([Schema.String, Schema.Number]),
            values: Schema.Array(Schema.Unknown),
        })
    ),
});
export const validateQueryShape = Schema.decodeUnknownSync(QueryShape);
