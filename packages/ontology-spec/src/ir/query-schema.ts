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

/** Expression tags own operator identity; these shared payloads own arity. */
export const queryExpressionVariants = [
    ...[
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
        "add",
        "subtract",
        "multiply",
        "divide",
    ].map((name) => ({ name, type: ref("BinaryExpression") })),
    ...["and", "or", "concat", "coalesce"].map((name) => ({ name, type: ref("VariadicExpression") })),
    { name: "not", type: ref("NotExpression") },
    { name: "case", type: ref("CaseExpression") },
    { name: "exists", type: ref("ExistsExpression") },
];

/** Portable grammar. Interpreters validate capabilities, types and binding scopes. */
export const queryTypes: NamedTypeDef[] = [
    struct("BinaryExpression", "Two operands for a top-level binary expression variant.", [
        field("left", ref("Expression")),
        field("right", ref("Expression")),
    ]),
    struct("VariadicExpression", "An ordered list of operands for a variadic expression variant.", [
        field("expressions", list("Expression")),
    ]),
    struct("NotExpression", "Negates a boolean expression, preserving evaluation uncertainty.", [
        field("expression", ref("Expression")),
    ]),
    struct("CaseBranch", "A condition and its scalar result; branches are tested in order.", [
        field("condition", ref("Expression")),
        field("result", ref("Expression")),
    ]),
    struct("CaseExpression", "Computes the first matching branch result, or the explicit else result.", [
        field("branches", list("CaseBranch")),
        field("else", ref("Expression")),
    ]),
    struct("ExistsExpression", "Whether a correlated query produces at least one result.", [
        field("query", ref("Query")),
    ]),
    struct("QuerySource", "A logical object source, resolved by an execution binding rather than raw SQL.", [
        field("ontology", optional(o.string({}))),
        field("objectType", o.string({})),
    ]),
    struct("QueryFrom", "Introduces a source with an explicit lexical row binding.", [
        field("source", ref("QuerySource")),
        field("binding", o.string({})),
    ]),
    struct("QueryOrder", "Orders by an expression with explicit nullish placement when requested.", [
        field("expression", ref("Expression")),
        field("direction", optional(options("asc", "desc"))),
        field("nulls", optional(options("first", "last"))),
    ]),
    struct(
        "QueryCursor",
        "An exclusive boundary in the complete order, with source primary-key tie-breaking.",
        [field("values", o.list({ elementType: o.unknown({}) })), field("key", o.unknown({}))]
    ),
    struct("QueryPage", "A result window; correlated child windows apply independently per parent.", [
        field("limit", optional(o.integer({}))),
        field("offset", optional(o.integer({}))),
        field("after", optional(ref("QueryCursor"))),
    ]),
    struct("Subset", "Filter, order and window over a supplied source; no arbitrary result projection.", [
        field("where", optional(ref("Expression"))),
        field("orderBy", optional(list("QueryOrder"))),
        field("page", optional(ref("QueryPage"))),
    ]),
    struct("QueryFieldSelection", "Selects a named value; entity uses require source-preserving identity.", [
        field("name", o.string({})),
        field("expression", ref("Expression")),
    ]),
    struct("QuerySubSelection", "Selects a nested correlated query with explicit result cardinality.", [
        field("name", o.string({})),
        field("query", ref("Query")),
        field("cardinality", options("one", "many")),
    ]),
    struct("SelectCaseBranch", "A condition and its selection group; branches are tested in order.", [
        field("condition", ref("Expression")),
        field("select", list("QuerySelection")),
    ]),
    struct("SelectCaseSelection", "Includes the first matching selection group, or else; groups can nest.", [
        field("branches", list("SelectCaseBranch")),
        field("else", optional(list("QuerySelection"))),
    ]),
    {
        name: "QuerySelection",
        description: "Named values, hierarchical queries and conditional inline selection groups.",
        type: o.union({
            variants: [
                { name: "field", type: ref("QueryFieldSelection") },
                { name: "sub", type: ref("QuerySubSelection") },
                { name: "selectCase", type: ref("SelectCaseSelection") },
            ],
        }),
    },
    struct("Query", "A finite query; nested reads may capture ancestor row bindings.", [
        field("from", ref("QueryFrom")),
        field("subset", optional(ref("Subset"))),
        field("select", list("QuerySelection")),
    ]),
    struct("QueryDocument", "A multi-root selection without a mandatory starting object type.", [
        field("inputs", optional(list("FieldDef"))),
        field("select", list("QuerySelection")),
    ]),
];
