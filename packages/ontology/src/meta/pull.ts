import { and, inArray, Query, queryOnce } from "@tanstack/db";
import type { OntologyIR } from "../ir/generated/types.js";
import type { LiveOntology } from "../LiveOntology.js";
import type { MetaOntology, ObjectType, TypeDef } from "../ontology/generated/types.js";

function getValueTypes(type: TypeDef): string[] {
    switch (type.kind) {
        case "list":
            return getValueTypes(type.value.elementType);
        case "map":
            return [...getValueTypes(type.value.keyType), ...getValueTypes(type.value.valueType)];
        case "optional":
            return getValueTypes(type.value.type);
        case "result":
            return [...getValueTypes(type.value.okType), ...getValueTypes(type.value.errType)];
        case "struct":
            return type.value.fields.flatMap((field) => getValueTypes(field.type));
        case "ref":
            return [type.value.name];
        default:
            return [];
    }
}

function getObjectTypeValueTypes(objectType: ObjectType): string[] {
    return Array.from(new Set(objectType.properties.flatMap((p) => getValueTypes(p.type))));
}

// TODO: port this to pure queries once we can do some sort of explode operation.

export async function pull(
    ontology: LiveOntology<MetaOntology>,
    objectTypeNames: string[]
): Promise<OntologyIR> {
    const { ValueType, ObjectType, LinkType } = ontology.objects;

    const objectTypesQuery = new Query()
        .from({ ObjectType })
        .where(({ ObjectType }) => inArray(ObjectType.name, objectTypeNames));

    const objectTypes = await queryOnce(() => objectTypesQuery);

    const valueTypeNames = Array.from(new Set(objectTypes.flatMap(getObjectTypeValueTypes)));

    const [types, linkTypes] = await Promise.all([
        queryOnce((q) =>
            q.from({ ValueType }).where(({ ValueType }) => inArray(ValueType.name, valueTypeNames))
        ),
        queryOnce((q) =>
            q
                .from({ LinkType })
                .where(({ LinkType }) =>
                    and(
                        inArray(LinkType.source.objectType, objectTypeNames),
                        inArray(LinkType.target.objectType, objectTypeNames)
                    )
                )
        ),
    ]);

    return {
        types,
        objectTypes,
        linkTypes,
    };
}
