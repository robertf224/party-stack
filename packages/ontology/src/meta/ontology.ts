import { invariant } from "@bobbyfidz/panic";
import { o } from "../ir/generated/builders.js";
import OntologyIRSchema from "../ir/schema.js";
import type {
    FieldDef,
    NamedTypeDef,
    OntologyIR,
} from "../ir/generated/types.js";

const idField = (description: string): FieldDef => ({
    name: "id",
    displayName: "ID",
    type: o.string({}),
    description,
});

function addRuntimeMetaFields(type: NamedTypeDef): NamedTypeDef {
    if (type.name !== "ObjectTypeDef" && type.name !== "PropertyDef") {
        return type;
    }

    invariant(type.type.kind === "struct", `${type.name} must be a struct.`);

    if (type.name === "PropertyDef") {
        return {
            ...type,
            type: o.struct({
                fields: [
                    idField("The provider-assigned stable identifier for this property."),
                    ...type.type.value.fields,
                ],
            }),
        };
    }

    const fields = type.type.value.fields.flatMap((field) =>
        field.name === "primaryKey"
            ? [
                  field,
                  {
                      name: "title",
                      displayName: "Title",
                      type: o.optional({ type: o.string({}) }),
                      description:
                          "The optional property name used as the human-readable title for an object.",
                  } satisfies FieldDef,
              ]
            : [field]
    );

    return {
        ...type,
        type: o.struct({
            fields: [
                idField("The provider-assigned stable identifier for this object type."),
                ...fields,
            ],
        }),
    };
}

const metaTypes = OntologyIRSchema.types
    .filter((type) => type.name !== "OntologyIR")
    .map(addRuntimeMetaFields);

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
