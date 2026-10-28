import { o } from "./generated/builders.js";
import type { FieldDef, NamedTypeDef, TypeDef } from "./generated/types.js";
const field = (name: string, type: TypeDef): FieldDef => ({ name, displayName: name, type });
const ref = (name: string) => o.ref({ name });
const optional = (type: TypeDef) => o.optional({ type });
const list = (name: string) => o.list({ elementType: ref(name) });
const struct = (name: string, description: string, fields: FieldDef[]): NamedTypeDef => ({
    name,
    description,
    type: o.struct({ fields }),
});
export const policyTypes: NamedTypeDef[] = [
    struct("ContextDef", "Typed trusted execution context and optional stable data-partition paths.", [
        field("type", optional(ref("TypeDef"))),
        field("partition", optional(o.list({ elementType: o.list({ elementType: o.string({}) }) }))),
    ]),
    struct(
        "ActionParameterBinding",
        "A server-bound action parameter, hidden from the public parameter contract.",
        [field("parameter", o.string({})), field("expression", ref("Expression"))]
    ),
    struct(
        "ActionPolicy",
        "Authorizes one action through a check, with optional bindings and additional mutator reads.",
        [
            field("actionType", o.string({})),
            field("check", ref("Expression")),
            field("bind", optional(list("ActionParameterBinding"))),
            field("read", optional(ref("QueryDocument"))),
        ]
    ),
    struct(
        "QueryFunctionPolicy",
        "Authorizes one query function and optional additional trusted implementation reads.",
        [
            field("queryFunctionType", o.string({})),
            field("check", ref("Expression")),
            field("read", optional(ref("QueryDocument"))),
        ]
    ),
    struct(
        "PolicyDef",
        "One effective policy for an ontology view; grants are evaluated under its trusted context.",
        [
            field("read", ref("QueryDocument")),
            field("actions", optional(list("ActionPolicy"))),
            field("queryFunctions", optional(list("QueryFunctionPolicy"))),
        ]
    ),
    struct(
        "OntologyDescriptor",
        "Singleton descriptive and execution-contract metadata for one ontology view.",
        [
            field("id", o.string({})),
            field("displayName", optional(o.string({}))),
            field("description", optional(o.string({}))),
            field("context", optional(ref("ContextDef"))),
            field("policy", optional(ref("PolicyDef"))),
        ]
    ),
];
