import type { Query } from "@party-stack/ontology-storage";
import type { LoadSubsetOptions } from "@tanstack/db";

export interface CollectionDemandDiagnostic {
    readonly objectType: string;
    readonly query?: Query;
    /** Tab-local source demand before storage translation; never sent to the backend. */
    readonly requested?: Pick<LoadSubsetOptions, "where" | "orderBy" | "limit" | "offset" | "cursor">;
    readonly exact?: boolean;
    readonly filterExact?: boolean;
    readonly orderExact?: boolean;
    /** In-process identity only; never serialized or sent to a replica owner. */
    readonly subscription?: object;
}
const readers = new WeakMap<object, () => readonly CollectionDemandDiagnostic[]>();
/** Read existing acquisitions without starting sync, acquiring demand, or reading rows. */
export const getCollectionDemands = (collection: object): readonly CollectionDemandDiagnostic[] =>
    readers.get(collection)?.() ?? [];

export function registerCollectionDemands(
    collection: object,
    read: () => readonly CollectionDemandDiagnostic[]
) {
    readers.set(collection, read);
    return () => {
        if (readers.get(collection) === read) readers.delete(collection);
    };
}
