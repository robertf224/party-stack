import { and, inArray, Query, queryOnce } from "@tanstack/db";
import type { OntologyIR } from "../ir/generated/types.js";
import type { LiveOntology } from "../live/LiveOntology.js";
import type { ActionType, MetaOntology, ObjectType, QueryType, TypeDef } from "./generated/types.js";

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

function getActionTypeValueTypes(actionType: ActionType): string[] {
    return actionType.parameters.flatMap((parameter) => getValueTypes(parameter.type));
}

function getQueryTypeValueTypes(queryType: QueryType): string[] {
    return [
        ...queryType.parameters.flatMap((parameter) => getValueTypes(parameter.type)),
        ...getValueTypes(queryType.returnType),
    ];
}

// TODO: port this to pure queries once we can do some sort of explode operation.

export interface PullOptions {
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryTypeNames: string[];
}

export async function pull(
    ontology: LiveOntology<MetaOntology>,
    options: PullOptions
): Promise<OntologyIR> {
    const { ValueType, ObjectType, LinkType, ActionType, QueryType } = ontology.objects;
    const { objectTypeNames, actionTypeNames, queryTypeNames } = options;

    const objectTypesQuery = new Query()
        .from({ ObjectType })
        .where(({ ObjectType }) => inArray(ObjectType.name, objectTypeNames));

    const objectTypes = await queryOnce(() => objectTypesQuery);

    const [linkTypes, actionTypes, queryTypes] = await Promise.all([
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
        queryOnce((q) => q.from({ ActionType }).where(({ ActionType }) => inArray(ActionType.name, actionTypeNames))),
        queryOnce((q) =>
            q.from({ QueryType }).where(({ QueryType }) => inArray(QueryType.name, queryTypeNames))
        ),
    ]);

    const valueTypeNames = Array.from(
        new Set([
            ...objectTypes.flatMap(getObjectTypeValueTypes),
            ...actionTypes.flatMap(getActionTypeValueTypes),
            ...queryTypes.flatMap(getQueryTypeValueTypes),
        ])
    );

    const types = await queryOnce((q) =>
        q.from({ ValueType }).where(({ ValueType }) => inArray(ValueType.name, valueTypeNames))
    );

    return {
        types,
        objectTypes,
        linkTypes,
        actionTypes,
        queryTypes,
    };
}
