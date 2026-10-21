import { OntologyObjectsV2 } from "@osdk/foundry.ontologies";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import type { SearchJsonQueryV2, SearchOrderByV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

/** Shared HTTP/pagination path. Callers translate their query syntax before searching. */
export async function searchFoundryObjects(
    client: OntologyClient,
    objectType: string,
    selectedProperties: string[],
    options: {
        readonly where?: SearchJsonQueryV2;
        readonly orderBy?: SearchOrderByV2;
        readonly offset?: number;
        readonly limit?: number;
        readonly signal?: AbortSignal;
    },
    decodeObject: (object: Record<string, unknown>) => Record<string, unknown> = (object) => object
): Promise<Record<string, unknown>[]> {
    options.signal?.throwIfAborted();
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.trunc(options.limit));
    if (limit === 0 || (options.where?.type === "in" && options.where.value.length === 0)) return [];
    const requestClient = options.signal
        ? {
              ...client,
              fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                  client.fetch(input, {
                      ...init,
                      signal: init?.signal ? AbortSignal.any([options.signal!, init.signal]) : options.signal,
                  }),
          }
        : client;
    const results = await AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                OntologyObjectsV2.search(requestClient, client.ontologyRid, objectType, {
                    snapshot: true,
                    where: options.where,
                    excludeRid: true,
                    select: selectedProperties,
                    selectV2: [],
                    pageSize,
                    pageToken,
                    orderBy: options.orderBy,
                }),
            (page) => page.nextPageToken,
            (page) => page.data,
            10_000,
            limit === undefined ? undefined : offset + limit
        )
    );
    options.signal?.throwIfAborted();
    return results.slice(offset, limit === undefined ? undefined : offset + limit).map(decodeObject);
}
