import { OntologyIRSchema } from "@party-stack/ontology-spec/effect";
import { Schema } from "effect";
import { encodeValue } from "./storage/values.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { FieldDef, QueryDocument, TypeDef } from "@party-stack/ontology-spec";

const decodeDefinition = Schema.decodeUnknownSync(OntologyIRSchema, { onExcessProperty: "error" });

/** Stable across property ordering introduced by schema/wire decoding.
 * The portable codec also preserves literal undefined, Temporal and collection values.
 */
export function ontologyDefinitionSignature(ir: OntologyIR): string {
    return encodeValue(decodeDefinition(ir));
}

const presentation = new Set([
    "displayName",
    "pluralDisplayName",
    "description",
    "deprecated",
    "icon",
    "color",
    "title",
]);
// Only call this for definition nodes. Expressions, literal data and provider
// metadata may legitimately have these same keys and must retain their meaning.
const contractNode = (node: object) =>
    Object.fromEntries(Object.entries(node).filter(([key]) => !presentation.has(key)));
const contractField = (field: FieldDef): unknown => ({
    ...contractNode(field),
    type: contractType(field.type),
});
function contractType(type: TypeDef): unknown {
    switch (type.kind) {
        case "string": {
            const constraint = type.value.constraint;
            return {
                ...type,
                value: {
                    constraint:
                        constraint?.kind === "enum"
                            ? {
                                  ...constraint,
                                  value: {
                                      ...constraint.value,
                                      options: constraint.value.options.map((option) => ({
                                          value: option.value,
                                      })),
                                  },
                              }
                            : constraint,
                },
            };
        }
        case "struct":
            return { ...type, value: { ...type.value, fields: type.value.fields.map(contractField) } };
        case "union":
            return {
                ...type,
                value: {
                    ...type.value,
                    variants: type.value.variants.map((variant) => ({
                        ...variant,
                        type: contractType(variant.type),
                    })),
                },
            };
        case "list":
            return { ...type, value: { ...type.value, elementType: contractType(type.value.elementType) } };
        case "map":
            return {
                ...type,
                value: {
                    ...type.value,
                    keyType: contractType(type.value.keyType),
                    valueType: contractType(type.value.valueType),
                },
            };
        case "optional":
        case "encrypted":
            return { ...type, value: { ...type.value, type: contractType(type.value.type) } };
        case "result":
            return {
                ...type,
                value: {
                    ...type.value,
                    okType: contractType(type.value.okType),
                    errType: contractType(type.value.errType),
                },
            };
        default:
            return type;
    }
}
const contractQuery = (query: QueryDocument) => ({
    ...query,
    inputs: query.inputs?.map(contractField),
});

/** Execution/wire identity, excluding presentation on explicit definition nodes.
 * Retains action logic/defaults, policy expressions, literal values, provider
 * metadata and all type constraints. This is not a schema migration policy.
 */
export function ontologyDefinitionContractSignature(ir: OntologyIR): string {
    const definition = decodeDefinition(ir);
    return encodeValue({
        ...contractNode(definition),
        types: definition.types.map((type) => ({ ...contractNode(type), type: contractType(type.type) })),
        objectTypes: definition.objectTypes.map((object) => ({
            ...contractNode(object),
            properties: object.properties.map(contractField),
        })),
        linkTypes: definition.linkTypes.map((link) => ({
            ...link,
            source: contractNode(link.source),
            target: contractNode(link.target),
        })),
        actionTypes: definition.actionTypes.map((action) => ({
            ...contractNode(action),
            parameters: action.parameters.map(contractField),
            returnType: action.returnType && contractType(action.returnType),
        })),
        queryFunctionTypes: definition.queryFunctionTypes.map((query) => ({
            ...contractNode(query),
            parameters: query.parameters.map(contractField),
            returnType: contractType(query.returnType),
        })),
        context: definition.context && {
            ...definition.context,
            type: definition.context.type && contractType(definition.context.type),
        },
        policy: definition.policy && {
            ...definition.policy,
            objects: contractQuery(definition.policy.objects),
            actions: definition.policy.actions?.map((action) => ({
                ...action,
                additionalObjects: action.additionalObjects && contractQuery(action.additionalObjects),
            })),
            queryFunctions: definition.policy.queryFunctions?.map((query) => ({
                ...query,
                additionalObjects: query.additionalObjects && contractQuery(query.additionalObjects),
            })),
        },
    });
}
