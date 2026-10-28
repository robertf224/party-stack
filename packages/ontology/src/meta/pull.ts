import { validate } from "@party-stack/ontology-spec";
import { and, inArray, Query, queryOnce } from "@tanstack/db";
import type { LiveOntology } from "../live/LiveOntology.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type {
    ActionType,
    MetaOntology,
    ObjectType,
    QueryFunctionType,
    TypeDef,
} from "@party-stack/ontology-spec/meta";

function getValueTypes(type: TypeDef): string[] {
    switch (type.kind) {
        case "list":
            return getValueTypes(type.value.elementType);
        case "map":
            return [...getValueTypes(type.value.keyType), ...getValueTypes(type.value.valueType)];
        case "optional":
            return getValueTypes(type.value.type);
        case "encrypted":
            return getValueTypes(type.value.type);
        case "result":
            return [...getValueTypes(type.value.okType), ...getValueTypes(type.value.errType)];
        case "struct":
            return type.value.fields.flatMap((field) => getValueTypes(field.type));
        case "union":
            return type.value.variants.flatMap((variant) => getValueTypes(variant.type));
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

function getQueryFunctionTypeValueTypes(queryFunctionType: QueryFunctionType): string[] {
    return [
        ...queryFunctionType.parameters.flatMap((parameter) => getValueTypes(parameter.type)),
        ...getValueTypes(queryFunctionType.returnType),
    ];
}

// TODO: port this to pure queries once we can do some sort of explode operation.

export interface PullOptions {
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryFunctionTypeNames: string[];
}

export async function pull(ontology: LiveOntology<MetaOntology>, options: PullOptions): Promise<OntologyIR> {
    const { ValueType, ObjectType, LinkType, ActionType, QueryFunctionType, Ontology } = ontology.objects;
    const { objectTypeNames, actionTypeNames, queryFunctionTypeNames } = options;

    const objectTypesQuery = new Query()
        .from({ ObjectType })
        .where(({ ObjectType }) => inArray(ObjectType.name, objectTypeNames));

    const objectTypes = await queryOnce(() => objectTypesQuery);
    const descriptors = await queryOnce((q) =>
        q
            .from({ Ontology })
            .orderBy(({ Ontology }) => Ontology.id, "asc")
            .limit(2)
    );
    if (descriptors.length !== 1 || descriptors[0]?.id !== "ontology")
        throw new Error("Metadata must expose exactly one Ontology descriptor with id ontology.");
    const descriptor = descriptors[0];

    const [linkTypes, actionTypes, queryFunctionTypes] = await Promise.all([
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
        queryOnce((q) =>
            q.from({ ActionType }).where(({ ActionType }) => inArray(ActionType.name, actionTypeNames))
        ),
        queryOnce((q) =>
            q
                .from({ QueryFunctionType })
                .where(({ QueryFunctionType }) => inArray(QueryFunctionType.name, queryFunctionTypeNames))
        ),
    ]);

    const valueTypeNames = Array.from(
        new Set([
            ...objectTypes.flatMap(getObjectTypeValueTypes),
            ...actionTypes.flatMap(getActionTypeValueTypes),
            ...queryFunctionTypes.flatMap(getQueryFunctionTypeValueTypes),
            ...(descriptor?.context?.type ? getValueTypes(descriptor.context.type) : []),
        ])
    );

    const types: OntologyIR["types"] = [];
    const loaded = new Set<string>();
    let pending = valueTypeNames;
    while (pending.length) {
        const batch = await queryOnce((q) =>
            q.from({ ValueType }).where(({ ValueType }) => inArray(ValueType.name, pending))
        );
        for (const type of batch) {
            loaded.add(type.name);
            types.push(type);
        }
        const missing = pending.filter((name) => !loaded.has(name));
        if (missing.length) throw new Error(`Missing metadata value types: ${missing.join(", ")}.`);
        pending = [...new Set(batch.flatMap((type) => getValueTypes(type.type)))].filter(
            (name) => !loaded.has(name)
        );
    }

    const result: OntologyIR = {
        types,
        objectTypes,
        linkTypes,
        actionTypes,
        queryFunctionTypes,
        ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
        ...(descriptor?.description === undefined ? {} : { description: descriptor.description }),
        ...(descriptor?.context === undefined ? {} : { context: descriptor.context }),
        ...(descriptor?.policy === undefined ? {} : { policy: descriptor.policy }),
    };
    const valid = validate(result);
    if (valid.kind === "err")
        throw new Error(
            `Pulled ontology is incomplete or invalid: ${valid.value.map((issue) => issue.message).join(" ")}`
        );
    return result;
}
