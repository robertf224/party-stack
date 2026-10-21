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
});
// Shape validation whitelists every SQL operator and ordering token before compilation.
// Scalar semantics (including Temporal) are validated by scalarKey, shared with indexes.
const PredicateShape = Schema.Union([
    Schema.Struct({
        op: Schema.Literals(["eq", "ne", "lt", "lte", "gt", "gte"]),
        left: Schema.Unknown,
        right: Schema.Unknown,
    }),
    Schema.Struct({ op: Schema.Literal("in"), left: Schema.Unknown, values: Schema.Array(Schema.Unknown) }),
    Schema.Struct({ op: Schema.Literal("contains"), left: FieldSchema, right: Schema.Unknown }),
    Schema.Struct({
        op: Schema.Literals(["like", "ilike"]),
        left: Schema.Unknown,
        right: Schema.Union([Schema.String, FieldSchema]),
    }),
    Schema.Struct({
        op: Schema.Literals(["and", "or"]),
        predicates: Schema.Array(Schema.suspend((): Schema.Codec<unknown> => PredicateShape)),
    }),
    Schema.Struct({
        op: Schema.Literal("not"),
        predicate: Schema.suspend((): Schema.Codec<unknown> => PredicateShape),
    }),
]);
export const QueryShape = Schema.Struct({
    where: Schema.optional(PredicateShape),
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
