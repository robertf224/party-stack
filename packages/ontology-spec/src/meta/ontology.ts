import { invariant } from "@bobbyfidz/panic";
import { o } from "../ir/generated/builders.js";
import OntologyIRSchema from "../ir/schema.js";
import type { FieldDef, NamedTypeDef, OntologyIR } from "../ir/generated/types.js";

// The definition's own types, so a definition round-trips through meta rows. Ids are optional in a
// definition and required as rows: a definition without them is given its defaults
// (`withDefinitionIds`).
const identified = new Set([
    "ObjectTypeDef",
    "PropertyDef",
    "LinkTypeDef",
    "ActionTypeDef",
    "QueryFunctionTypeDef",
    "NamedTypeDef",
]);
const requireId = (type: NamedTypeDef): NamedTypeDef => {
    if (!identified.has(type.name)) return type;
    invariant(type.type.kind === "struct", `${type.name} must be a struct.`);
    return {
        ...type,
        type: o.struct({
            fields: type.type.value.fields.map((field) =>
                field.name === "id" ? { ...field, type: o.string({}) } : field
            ),
        }),
    };
};
const metaTypes = OntologyIRSchema.types.filter((type) => type.name !== "OntologyIR").map(requireId);

function lift(
    schema: Pick<OntologyIR, "types">,
    objectTypes: Record<
        string,
        { name?: string; primaryKey: string; displayName: string; pluralDisplayName: string }
    >
): Pick<OntologyIR, "types" | "objectTypes"> {
    return {
        types: schema.types.filter((type) => !(type.name in objectTypes)),
        objectTypes: schema.types
            .filter((type) => type.name in objectTypes)
            .map((type) => {
                invariant(type.type.kind === "struct", "Can only lift struct type into object type.");
                const { name, primaryKey, displayName, pluralDisplayName } = objectTypes[type.name]!;
                return {
                    name: name ?? type.name,
                    displayName: displayName,
                    pluralDisplayName,
                    primaryKey,
                    deprecated: type.deprecated,
                    description: type.description,
                    properties: type.type.value.fields,
                };
            }),
    };
}

export default {
    ...lift(
        { types: metaTypes },
        {
            OntologyDescriptor: {
                name: "Ontology",
                primaryKey: "id",
                displayName: "Ontology",
                pluralDisplayName: "Ontologies",
            },
            ObjectTypeDef: {
                name: "ObjectType",
                primaryKey: "name",
                displayName: "Object type",
                pluralDisplayName: "Object types",
            },
            LinkTypeDef: {
                name: "LinkType",
                primaryKey: "id",
                displayName: "Link type",
                pluralDisplayName: "Link types",
            },
            ActionTypeDef: {
                name: "ActionType",
                primaryKey: "name",
                displayName: "Action type",
                pluralDisplayName: "Action types",
            },
            QueryFunctionTypeDef: {
                name: "QueryFunctionType",
                primaryKey: "name",
                displayName: "Query function type",
                pluralDisplayName: "Query function types",
            },
            NamedTypeDef: {
                name: "ValueType",
                primaryKey: "name",
                displayName: "Value type",
                pluralDisplayName: "Value types",
            },
        }
    ),
    linkTypes: [
        {
            id: "LinkType:source",
            source: { objectType: "LinkType", name: "outgoingLinkTypes", displayName: "Outgoing link types" },
            target: {
                objectType: "ObjectType",
                name: "source",
                displayName: "Source",
            },
            foreignKey: "source.objectType",
            cardinality: "many",
        },
        {
            id: "LinkType:target",
            source: { objectType: "LinkType", name: "incomingLinkTypes", displayName: "Incoming link types" },
            target: { objectType: "ObjectType", name: "target", displayName: "Target" },
            foreignKey: "target.objectType",
            cardinality: "many",
        },
    ],
    actionTypes: [],
    queryFunctionTypes: [],
} satisfies OntologyIR;
