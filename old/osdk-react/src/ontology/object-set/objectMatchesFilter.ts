/* eslint-disable @typescript-eslint/no-explicit-any */

// Adapted from https://github.com/palantir/osdk-ts/blob/main/packages/client/src/observable/internal/objectMatchesWhereClause.ts

import type { ObjectOrInterfaceDefinition, Osdk, PossibleWhereClauseFilters, WhereClause } from "@osdk/api";

export function objectMatchesFilter<T extends ObjectOrInterfaceDefinition>(
    object: Osdk<T>,
    filter: WhereClause<T>
): boolean {
    if (Object.keys(filter).length === 0) {
        return true;
    }

    if ("$and" in filter) {
        const andFilter = filter.$and as WhereClause<T>[];
        return andFilter.every((w) => objectMatchesFilter(object, w));
    }
    if ("$or" in filter) {
        const orFilter = filter.$or as WhereClause<T>[];
        return orFilter.some((w) => objectMatchesFilter(object, w));
    }
    if ("$not" in filter) {
        const notFilter = filter.$not as WhereClause<T>;
        return !objectMatchesFilter(object, notFilter);
    }

    return Object.entries(filter).every(([key, filter]) => {
        if (typeof filter === "object") {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const propertyValue = object[key as keyof typeof object] as any;
            const [firstFilter] = Object.keys(
                filter as Record<string, any>
            ) as Array<PossibleWhereClauseFilters>;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const filterValue = (filter as Record<string, any>)[firstFilter!];

            switch (firstFilter) {
                case "$eq":
                    return propertyValue === filterValue;
                case "$gt":
                    return propertyValue > filterValue;
                case "$lt":
                    return propertyValue < filterValue;
                case "$gte":
                    return propertyValue >= filterValue;
                case "$lte":
                    return propertyValue <= filterValue;
                case "$ne":
                    return propertyValue !== filterValue;
                case "$in":
                    return (filterValue as Array<unknown>).includes(propertyValue);
                case "$isNull":
                    return propertyValue === null || propertyValue === undefined;
                case "$startsWith":
                    return (propertyValue as string).startsWith(filterValue as string);
                // TODO: implement other filters
                default:
                    return false;
            }
        }

        if (key in object) {
            if (object[key as keyof typeof object] === filter) {
                return true;
            }
        }

        return false;
    });
}
