import { FieldPath, LoadSubsetOptions, parseOrderByExpression, parseWhereExpression } from "@tanstack/db";
import type { MetaActionType } from "@party-stack/ontology";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import type {
    ActionTypeSearchJsonQueryV2,
    ActionTypeSortByV2,
    SearchActionTypesOrderByV2,
} from "@osdk/foundry.ontologies";

const FILTER_FIELDS = {
    id: "actionTypeRid",
    name: "actionTypeApiName",
    displayName: "actionTypeDisplayName",
} as const satisfies Partial<Record<keyof MetaActionType, ActionTypeSearchJsonQueryV2["type"]>>;

const ORDER_BY_FIELDS = {
    displayName: "actionTypeDisplayName",
} as const satisfies Partial<Record<keyof MetaActionType, ActionTypeSortByV2>>;

function getFilterField(field: FieldPath): keyof typeof FILTER_FIELDS {
    const name = field.join(".");
    if (name && Object.hasOwn(FILTER_FIELDS, name)) {
        return name as keyof typeof FILTER_FIELDS;
    }
    throw new Error(`Foundry ActionType search does not support filtering by "${name}".`);
}

function eq(field: FieldPath, value: unknown): ActionTypeSearchJsonQueryV2 {
    const name = getFilterField(field);
    if (name === "id") {
        return {
            type: "actionTypeRid",
            value: value as string,
        };
    }
    return {
        type: FILTER_FIELDS[name],
        value: {
            type: "exact",
            value: name === "name" ? toFoundryActionTypeName(value as string) : (value as string),
        },
    };
}

function like(field: FieldPath, value: string): ActionTypeSearchJsonQueryV2 {
    const name = getFilterField(field);
    if (name === "id") {
        throw new Error("Foundry ActionType search only supports exact filtering by id.");
    }
    const terms = value.split("%").filter(Boolean);
    const queries: ActionTypeSearchJsonQueryV2[] = terms.map((term) => ({
        type: FILTER_FIELDS[name],
        value: {
            type: "contains",
            value: name === "name" ? toFoundryActionTypeName(term) : term,
        },
    }));

    return queries.length === 1 ? queries[0]! : { type: "and", value: queries };
}

export function convertActionTypeLoadSubsetFilter(
    filter: LoadSubsetOptions["where"]
): ActionTypeSearchJsonQueryV2 | undefined {
    return (
        parseWhereExpression<ActionTypeSearchJsonQueryV2>(filter, {
            handlers: {
                and: (...filters: ActionTypeSearchJsonQueryV2[]) => ({
                    type: "and",
                    value: filters,
                }),
                or: (...filters: ActionTypeSearchJsonQueryV2[]) => ({
                    type: "or",
                    value: filters,
                }),
                eq,
                in: (field: FieldPath, values: unknown[]) => ({
                    type: "or",
                    value: values.map((value) => eq(field, value)),
                }),
                like,
                ilike: like,
            },
        }) ?? undefined
    );
}

export function convertActionTypeLoadSubsetOrderBy(
    orderBy: LoadSubsetOptions["orderBy"]
): SearchActionTypesOrderByV2 | undefined {
    const ordering = orderBy ? parseOrderByExpression(orderBy) : [];
    const { field, direction } = ordering[0] ?? {};
    const name = field?.join(".");
    if (ordering.length !== 1 || !name || !Object.hasOwn(ORDER_BY_FIELDS, name)) {
        return undefined;
    }

    return {
        field: ORDER_BY_FIELDS[name as keyof typeof ORDER_BY_FIELDS],
        direction,
    };
}
