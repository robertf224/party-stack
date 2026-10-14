import { Comparator } from "../utils";
import { ObjectSet } from "./object-set";
import type { FetchPageArgs, ObjectOrInterfaceDefinition, Osdk } from "@osdk/api";

// TODO: switch this to an array to preserve order when stringifying.
export type ObjectSetOrderBy<T extends ObjectOrInterfaceDefinition> = NonNullable<
    FetchPageArgs<T>["$orderBy"]
>;

export interface ObjectList<T extends ObjectOrInterfaceDefinition> {
    objectSet: ObjectSet<T>;
    orderBy: ObjectSetOrderBy<T>;
}

function getComparator<T extends ObjectOrInterfaceDefinition>(
    objectList: ObjectList<T>
): Comparator<Osdk<T>> {
    return (a, b) => {
        for (const [key, direction] of Object.entries(objectList.orderBy) as [
            keyof Osdk<T>,
            "asc" | "desc",
        ][]) {
            const aValue = a[key];
            const bValue = b[key];

            if (aValue === bValue) continue;
            if (aValue == null) return direction === "asc" ? -1 : 1;
            if (bValue == null) return direction === "asc" ? 1 : -1;
            return direction === "asc" ? (aValue < bValue ? -1 : 1) : aValue < bValue ? 1 : -1;
        }
        return 0;
    };
}

export const ObjectList = {
    getComparator,
};
