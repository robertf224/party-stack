import { o } from "./generated/builders.js";
import type { FieldDef, NamedTypeDef, TypeDef } from "./generated/types.js";

const field = (name: string, type: TypeDef): FieldDef => ({ name, displayName: name, type });
const ref = (name: string) => o.ref({ name });
const list = (name: string) => o.list({ elementType: ref(name) });
const optional = (type: TypeDef) => o.optional({ type });
const options = (...values: string[]) =>
    o.string({ constraint: o.StringConstraint.enum({ options: values.map((value) => ({ value })) }) });
const struct = (name: string, description: string, fields: FieldDef[]): NamedTypeDef => ({
    name,
    description,
    type: o.struct({ fields }),
});

/** Portable grammar. Execution, authorization and source resolution belong to
 * their respective interpreters; these definitions do not grant capabilities.
 */
export const queryTypes: NamedTypeDef[] = [
    struct("OperationExpression", "A closed portable operator applied to expression arguments.", [
        field(
            "operator",
            options(
                "eq",
                "ne",
                "lt",
                "lte",
                "gt",
                "gte",
                "in",
                "contains",
                "like",
                "ilike",
                "and",
                "or",
                "not",
                "add",
                "subtract",
                "multiply",
                "divide",
                "concat",
                "coalesce"
            )
        ),
        field("arguments", list("Expression")),
    ]),
    struct("ConditionalExpression", "Chooses a scalar value; distinct from a guarded field selection.", [
        field("condition", ref("Expression")),
        field("whenTrue", ref("Expression")),
        field("whenFalse", ref("Expression")),
    ]),
    struct("QueryTestExpression", "Tests correlated query membership without selecting its result.", [
        field("query", ref("Query")),
        field("test", options("some", "none")),
    ]),
    struct(
        "QuerySource",
        "A logical object source resolved by the execution binding, not a SQL identifier.",
        [field("ontology", optional(o.string({}))), field("objectType", o.string({}))]
    ),
    struct("QueryFrom", "Introduces a source with an explicit lexical row binding.", [
        field("source", ref("QuerySource")),
        field("binding", o.string({})),
    ]),
    struct("QueryJoin", "An explicit relational join; output fields do not define correlation scope.", [
        field("kind", options("inner", "left")),
        field("from", ref("QueryFrom")),
        field("on", ref("Expression")),
    ]),
    struct("QueryOrder", "Orders by an expression with explicit nullish placement when requested.", [
        field("expression", ref("Expression")),
        field("direction", optional(options("asc", "desc"))),
        field("nulls", optional(options("first", "last"))),
    ]),
    struct("QueryCursor", "An exclusive cursor over the query's complete sort order and result identity.", [
        field("values", o.list({ elementType: o.unknown({}) })),
        field("key", o.unknown({})),
    ]),
    struct("QueryPage", "A window; correlated child windows apply independently per parent.", [
        field("limit", optional(o.integer({}))),
        field("offset", optional(o.integer({}))),
        field("after", optional(ref("QueryCursor"))),
    ]),
    struct(
        "QueryFieldSelection",
        "Selects a named value. Entity uses require source-preserving property identity.",
        [field("name", o.string({})), field("expression", ref("Expression"))]
    ),
    struct("QueryNestedSelection", "Selects a nested correlated query with explicit result cardinality.", [
        field("name", o.string({})),
        field("query", ref("Query")),
        field("cardinality", options("one", "many")),
    ]),
    struct(
        "QueryGuardedSelection",
        "Conditionally includes fields/subtrees, preserving their source identities.",
        [
            field("condition", ref("Expression")),
            field("whenTrue", list("QuerySelection")),
            field("whenFalse", optional(list("QuerySelection"))),
        ]
    ),
    {
        name: "QuerySelection",
        description: "The same selection grammar supports result projections and entity-use validation.",
        type: o.union({
            variants: [
                { name: "field", type: ref("QueryFieldSelection") },
                { name: "query", type: ref("QueryNestedSelection") },
                { name: "when", type: ref("QueryGuardedSelection") },
            ],
        }),
    },
    struct("Query", "A finite relational query. Nested reads may capture ancestor row bindings.", [
        field("from", ref("QueryFrom")),
        field("joins", optional(list("QueryJoin"))),
        field("where", optional(ref("Expression"))),
        field("select", list("QuerySelection")),
        field("orderBy", optional(list("QueryOrder"))),
        field("page", optional(ref("QueryPage"))),
    ]),
    struct("QueryDocument", "A multi-root selection without a mandatory starting object type.", [
        field("inputs", optional(list("FieldDef"))),
        field("select", list("QuerySelection")),
    ]),
];
