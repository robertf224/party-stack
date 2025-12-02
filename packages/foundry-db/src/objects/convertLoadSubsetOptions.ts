import {
    PropertyApiName,
    PropertyIdentifier,
    SearchJsonQueryV2,
    SearchOrderByV2,
    StructFieldApiName,
} from "@osdk/foundry.ontologies";
import { FieldPath, LoadSubsetOptions, parseOrderByExpression, parseWhereExpression } from "@tanstack/db";

function fieldPathToPropertyIdentifier(fieldPath: FieldPath): PropertyIdentifier {
    if (fieldPath.length === 1) {
        return {
            type: "property",
            apiName: fieldPath[0]! as PropertyApiName,
        };
    } else if (fieldPath.length === 2) {
        return {
            type: "structField",
            propertyApiName: fieldPath[0]! as PropertyApiName,
            structFieldApiName: fieldPath[1]! as StructFieldApiName,
        };
    }
    throw new Error(`Invalid field path: ${fieldPath.join(".")}`);
}

export function convertLoadSubsetFilter(filter: LoadSubsetOptions["where"]): SearchJsonQueryV2 | undefined {
    return (
        parseWhereExpression<SearchJsonQueryV2>(filter, {
            handlers: {
                and: (...filters: SearchJsonQueryV2[]) => ({ type: "and", value: filters }),
                or: (...filters: SearchJsonQueryV2[]) => ({ type: "or", value: filters }),
                not: (filter: SearchJsonQueryV2) => ({ type: "not", value: filter }),
                eq: (field: FieldPath, value) => ({
                    type: "eq",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value,
                }),
                gt: (field: FieldPath, value) => ({
                    type: "gt",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value,
                }),
                gte: (field: FieldPath, value) => ({
                    type: "gte",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value,
                }),
                lt: (field: FieldPath, value) => ({
                    type: "lt",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value,
                }),
                lte: (field: FieldPath, value) => ({
                    type: "lte",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value,
                }),
                isNull: (field: FieldPath) => ({
                    type: "isNull",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value: true,
                }),
                in: (field: FieldPath, value: unknown[]) => ({
                    type: "in",
                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                    value: value.filter((v) => v !== null && v !== undefined),
                }),
                ilike: (field: FieldPath, value: string) =>
                    value !== "%"
                        ? {
                              type: "wildcard",
                              propertyIdentifier: fieldPathToPropertyIdentifier(field),
                              // https://github.com/TanStack/db/blob/dab41aec8d8fa042384b4c0f878b3731c1d4a2b0/packages/db/src/query/compiler/evaluators.ts#L479-L481
                              // https://www.palantir.com/docs/foundry/object-explorer/search-syntax#wildcards
                              value: value.toLowerCase().replace("_", "?").replace("%", "*"),
                          }
                        : { type: "and", value: [] },
            },
        }) ?? undefined
    );
}

export function convertLoadSubsetOrderBy(orderBy: LoadSubsetOptions["orderBy"]): SearchOrderByV2 | undefined {
    return orderBy
        ? {
              fields: parseOrderByExpression(orderBy).map((ordering) => ({
                  field: ordering.field[0]! as PropertyApiName,
                  direction: ordering.direction,
              })),
          }
        : undefined;
}
