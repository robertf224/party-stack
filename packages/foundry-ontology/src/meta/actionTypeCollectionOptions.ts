import { ActionTypesFullMetadata } from "@osdk/foundry.ontologies";
import {
    FieldPath,
    LoadSubsetOptions,
    parseWhereExpression,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { MetaActionType, OntologyCollectionOptions } from "@party-stack/ontology";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { convertFoundryMetaActionType } from "./convertMetaActionType.js";

const foundryPreviewOptions = {
    preview: true,
} as unknown as Parameters<typeof ActionTypesFullMetadata.get>[3];

export interface ActionTypeCollectionOpts {
    client: OntologyClient;
    queryClient?: QueryClient;
}

export function actionTypeCollectionOptions(opts: ActionTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<MetaActionType>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["foundry", "ontology", "actionTypes"],
        syncMode: "on-demand",
        queryFn: async (ctx) => {
            const query = convertActionTypeQuery(ctx.meta?.loadSubsetOptions);
            if (query.names.length === 0) {
                return [];
            }

            const actionTypeMetadata = await Promise.all(
                query.names.map((name) =>
                    ActionTypesFullMetadata.get(
                        opts.client,
                        opts.client.ontologyRid,
                        toFoundryActionTypeName(name),
                        foundryPreviewOptions
                    )
                )
            );
            return actionTypeMetadata.map(convertFoundryMetaActionType);
        },
    }) as unknown as OntologyCollectionOptions;
}

type ActionTypeQuery = { type: "byName"; names: string[] };

function convertActionTypeQuery(options?: LoadSubsetOptions): ActionTypeQuery {
    if (!options?.where) {
        throw new Error(
            'Foundry ActionType metadata currently only supports loadSubset queries filtered by "name".'
        );
    }

    const batchQuery =
        parseWhereExpression<ActionTypeQuery | undefined>(options.where, {
            handlers: {
                eq: (field: FieldPath, value: unknown) => {
                    if (field.join(".") === "name") {
                        return { type: "byName", names: [String(value)] };
                    }
                },
                in: (field: FieldPath, value: unknown[]) => {
                    if (field.join(".") === "name") {
                        return {
                            type: "byName",
                            names: value
                                .filter((candidate) => candidate !== null && candidate !== undefined)
                                .map(String),
                        };
                    }
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;

    if (!batchQuery) {
        throw new Error(
            'Foundry ActionType metadata currently only supports loadSubset queries filtered by "name".'
        );
    }

    return batchQuery;
}
