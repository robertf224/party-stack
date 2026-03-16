import { notImplemented } from "@bobbyfidz/panic";
import {
    type LinkTypeSideCardinality,
    type LinkTypeSideV2,
    type ObjectPropertyType,
    type ObjectTypeFullMetadata,
    OntologiesV2,
    type OntologyValueType,
    type PropertyV2,
    type StructFieldType,
    type ValueTypeConstraint,
    type ValueTypeFieldType,
} from "@osdk/foundry.ontologies";
import { createCollection, eq, liveQueryCollectionOptions, Query } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type {
    MetaLinkType,
    MetaObjectType,
    OntologyAdapter,
    OntologyCollectionOptions,
    PropertyDef,
    StringConstraint,
    TypeDef,
    MetaValueType,
} from "@party-stack/ontology";
import type { OntologyClient } from "../utils/client.js";

export interface CreateOntologyMetadataCollectionsOpts {
    client: OntologyClient;
}

type MetaEntity =
    | { entityType: "ObjectType"; entity: MetaObjectType }
    | { entityType: "ValueType"; entity: MetaValueType }
    | { entityType: "LinkType"; entity: MetaLinkType };

export function createFoundryMetaOntologyAdapter(
    opts: CreateOntologyMetadataCollectionsOpts
): OntologyAdapter {
    const queryClient = new QueryClient();
    const metadata = createCollection(
        queryCollectionOptions<MetaEntity>({
            queryClient,
            getKey: (row) => {
                switch (row.entityType) {
                    case "ObjectType":
                    case "ValueType":
                        return `${row.entityType}:${row.entity.name}`;
                    case "LinkType":
                        return `${row.entityType}:${row.entity.id}`;
                }
            },
            queryKey: ["foundry", "ontology", "metadata"],
            syncMode: "eager",
            queryFn: async () => {
                const loaded = await loadMetaOntologyObjects(opts.client);
                return [
                    ...loaded.objectTypes.map((entity) => ({
                        entityType: "ObjectType" as const,
                        entity,
                        ...entity,
                    })),
                    ...loaded.valueTypes.map((entity) => ({
                        entityType: "ValueType" as const,
                        entity,
                        ...entity,
                    })),
                    ...loaded.linkTypes.map((entity) => ({
                        entityType: "LinkType" as const,
                        entity,
                        ...entity,
                    })),
                ];
            },
        })
    );

    function createEntityCollectionOptions(entityType: MetaEntity["entityType"]): OntologyCollectionOptions {
        return liveQueryCollectionOptions({
            query: new Query()
                .from({ metadata })
                .where(({ metadata }) => eq(metadata.entityType, entityType)),
        }) as unknown as OntologyCollectionOptions;
    }

    return {
        name: "foundry-metadata",
        getCollectionOptions: (objectType: string) => {
            switch (objectType) {
                case "ObjectType":
                    return createEntityCollectionOptions("ObjectType");
                case "ValueType":
                    return createEntityCollectionOptions("ValueType");
                case "LinkType":
                    return createEntityCollectionOptions("LinkType");
                default:
                    throw new Error(`Unsupported Foundry metadata object type "${objectType}".`);
            }
        },
        applyAction: () => {
            notImplemented();
        },
        cleanup: async () => {
            await metadata.cleanup();
        },
    };
}

async function loadMetaOntologyObjects(client: OntologyClient): Promise<{
    objectTypes: MetaObjectType[];
    valueTypes: MetaValueType[];
    linkTypes: MetaLinkType[];
}> {
    const ontology = await OntologiesV2.getFullMetadata(client, client.ontologyRid);
    const objectTypes = Object.values(ontology.objectTypes);

    return {
        objectTypes: objectTypes.map(convertObjectType),
        valueTypes: Object.values(ontology.valueTypes).map(convertValueType),
        linkTypes: convertLinkTypes(objectTypes),
    };
}

function convertObjectType(objectType: ObjectTypeFullMetadata): MetaObjectType {
    return {
        name: objectType.objectType.apiName,
        displayName: objectType.objectType.displayName,
        pluralDisplayName: objectType.objectType.pluralDisplayName,
        primaryKey: objectType.objectType.primaryKey,
        description: objectType.objectType.description,
        properties: Object.entries(objectType.objectType.properties).map(([name, property]) =>
            convertProperty(name, property)
        ),
    };
}

function convertProperty(name: string, property: PropertyV2): PropertyDef {
    return {
        name,
        displayName: property.displayName ?? name,
        description: property.description,
        type: property.valueTypeApiName
            ? { kind: "ref", value: { name: property.valueTypeApiName } }
            : convertObjectPropertyType(property.dataType),
    };
}

function convertValueType(valueType: OntologyValueType): MetaValueType {
    return {
        name: valueType.apiName,
        description: valueType.description,
        deprecated: valueType.status === "DEPRECATED" ? { message: "Deprecated in Foundry." } : undefined,
        type: convertValueTypeFieldType(valueType.fieldType, valueType.constraints),
    };
}

function convertValueTypeFieldType(
    type: ValueTypeFieldType,
    constraints: ValueTypeConstraint[] = []
): TypeDef {
    switch (type.type) {
        case "string":
            return { kind: "string", value: { constraint: extractStringConstraint(constraints) } };
        case "boolean":
            return { kind: "boolean", value: {} };
        case "byte":
        case "short":
        case "integer":
        case "long":
            return { kind: "integer", value: {} };
        case "float":
            return { kind: "float", value: {} };
        case "double":
        case "decimal":
            return { kind: "double", value: {} };
        case "date":
            return { kind: "date", value: {} };
        case "timestamp":
            return { kind: "timestamp", value: {} };
        case "array":
            return {
                kind: "list",
                value: {
                    elementType: convertValueTypeFieldType(requireValue(type.subType, "array subtype")),
                },
            };
        case "optional":
            return {
                kind: "optional",
                value: { type: convertValueTypeFieldType(requireValue(type.wrappedType, "optional type")) },
            };
        case "map":
            return {
                kind: "map",
                value: {
                    keyType: convertValueTypeFieldType(requireValue(type.keyType, "map key type")),
                    valueType: convertValueTypeFieldType(requireValue(type.valueType, "map value type")),
                },
            };
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: type.fields.map((field, index) => ({
                        name: field.name ?? `field${index + 1}`,
                        displayName: field.name ?? `Field ${index + 1}`,
                        type: convertValueTypeFieldType(
                            requireValue(field.fieldType, `struct field "${field.name ?? index}" type`)
                        ),
                    })),
                },
            };
        case "union":
            return {
                kind: "union",
                value: {
                    variants: type.memberTypes.map((memberType, index) => ({
                        name: `variant${index + 1}`,
                        type: convertValueTypeFieldType(memberType),
                    })),
                },
            };
        default:
            throw new Error(`Unsupported Foundry value type "${type.type}".`);
    }
}

function convertObjectPropertyType(type: ObjectPropertyType): TypeDef {
    switch (type.type) {
        case "string":
            return { kind: "string", value: {} };
        case "boolean":
            return { kind: "boolean", value: {} };
        case "byte":
        case "short":
        case "integer":
        case "long":
            return { kind: "integer", value: {} };
        case "float":
            return { kind: "float", value: {} };
        case "double":
        case "decimal":
            return { kind: "double", value: {} };
        case "date":
            return { kind: "date", value: {} };
        case "timestamp":
            return { kind: "timestamp", value: {} };
        case "geopoint":
            return { kind: "geopoint", value: {} };
        case "cipherText":
        case "geoshape":
        case "geotimeSeriesReference":
        case "marking":
        case "timeseries":
            // These Foundry-specific runtime payloads do not have a first-class IR representation yet.
            return { kind: "string", value: {} };
        case "attachment":
        case "mediaReference":
            return { kind: "attachment", value: {} };
        case "vector":
            return {
                kind: "list",
                value: {
                    elementType: { kind: "double", value: {} },
                },
            };
        case "array":
            return {
                kind: "list",
                value: {
                    elementType: convertObjectPropertyType(requireValue(type.subType, "array subtype")),
                },
            };
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: type.structFieldTypes.map(convertStructField),
                },
            };
    }
}

function convertStructField(field: StructFieldType): PropertyDef {
    return {
        name: field.apiName,
        displayName: field.apiName,
        type: convertObjectPropertyType(field.dataType),
    };
}

function extractStringConstraint(constraints: ValueTypeConstraint[]): StringConstraint | undefined {
    const enumConstraint = constraints.find((constraint) => constraint.type === "enum");
    if (enumConstraint) {
        const options = enumConstraint.options
            .filter((option): option is string => typeof option === "string")
            .map((value) => ({ value }));
        if (options.length > 0) {
            return {
                kind: "enum",
                value: { options },
            };
        }
    }

    const regexConstraint = constraints.find((constraint) => constraint.type === "regex");
    if (regexConstraint) {
        return {
            kind: "regex",
            value: { regex: regexConstraint.pattern },
        };
    }

    return undefined;
}

function convertLinkTypes(objectTypes: ObjectTypeFullMetadata[]): MetaLinkType[] {
    const sidesByRid = new Map<string, LinkTypeSideV2[]>();

    for (const objectType of objectTypes) {
        for (const linkType of objectType.linkTypes) {
            const key = linkType.linkTypeRid;
            const sides = sidesByRid.get(key) ?? [];
            sides.push(linkType);
            sidesByRid.set(key, sides);
        }
    }

    return Array.from(sidesByRid.entries())
        .map(([id, sides]) => convertLinkType(id, sides))
        .filter((linkType): linkType is MetaLinkType => linkType !== null);
}

function convertLinkType(id: string, sides: LinkTypeSideV2[]): MetaLinkType | null {
    if (sides.length !== 2) {
        return null;
    }

    const source = sides.find((side) => side.foreignKeyPropertyApiName);
    if (!source) {
        return null;
    }

    const target = sides.find((side) => side !== source);
    if (!target) {
        return null;
    }

    return {
        id,
        source: {
            objectType: source.objectTypeApiName,
            name: source.apiName,
            displayName: source.displayName,
        },
        target: {
            objectType: target.objectTypeApiName,
            name: target.apiName,
            displayName: target.displayName,
        },
        foreignKey: requireValue(source.foreignKeyPropertyApiName, "link foreign key"),
        cardinality: convertCardinality(source.cardinality),
    };
}

function convertCardinality(cardinality: LinkTypeSideCardinality): MetaLinkType["cardinality"] {
    return cardinality === "ONE" ? "one" : "many";
}

function requireValue<T>(value: T | undefined, label: string): T {
    if (value === undefined) {
        throw new Error(`Expected Foundry ${label}.`);
    }

    return value;
}
