import { Client } from "@osdk/client";
import {
    SearchJsonQueryV2,
    OntologyObjectsV2,
    PropertyIdentifier,
    PropertyApiName,
    StructFieldApiName,
    OntologyObjectV2,
} from "@osdk/foundry.ontologies";
import { createCollection, FieldPath, parseWhereExpression } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import * as AsyncIterable from "../AsyncIterable.js";

export interface CreateObjectsCollectionOpts {
    client: Client;
    ontologyRid: string;
    objectType: string;
}

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

export function createObjectsCollection({ client, ontologyRid, objectType }: CreateObjectsCollectionOpts) {
    return createCollection(
        queryCollectionOptions<OntologyObjectV2>({
            queryClient: new QueryClient(),
            getKey: (object) => (object as { __primaryKey: string }).__primaryKey,
            queryKey: ["foundry", objectType],
            syncMode: "on-demand",
            queryFn: async (ctx) => {
                const loadSubsetOptions = ctx.meta?.loadSubsetOptions;

                let where: SearchJsonQueryV2 | undefined;
                if (loadSubsetOptions) {
                    where =
                        parseWhereExpression<SearchJsonQueryV2>(loadSubsetOptions.where, {
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
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                in: (field: FieldPath, value: any[]) => ({
                                    type: "in",
                                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                    value,
                                }),
                                ilike: (field: FieldPath, value: string) => ({
                                    type: "wildcard",
                                    propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                    // https://github.com/TanStack/db/blob/dab41aec8d8fa042384b4c0f878b3731c1d4a2b0/packages/db/src/query/compiler/evaluators.ts#L479-L481
                                    // https://www.palantir.com/docs/foundry/object-explorer/search-syntax#wildcards
                                    value: value.toLowerCase().replace("_", "?").replace("%", "*"),
                                }),
                            },
                        }) ?? undefined;
                }

                return AsyncIterable.toArray(
                    AsyncIterable.fromPagination(
                        (pageToken: string | undefined) =>
                            OntologyObjectsV2.search(client, ontologyRid, objectType, {
                                snapshot: true,
                                where,
                                excludeRid: true,
                                // TODO: figure out property selection
                                select: [],
                                pageToken,
                                // TODO: order by, page size
                            }),
                        (page) => page.nextPageToken,
                        (page) => page.data
                    )
                );
            },
        })
    );
}
