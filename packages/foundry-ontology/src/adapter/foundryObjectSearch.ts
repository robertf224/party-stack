import { OntologyObjectsV2 } from "@osdk/foundry.ontologies";
import { BackendError } from "@party-stack/ontology-backend";
import { Schema, Redacted } from "effect";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import type { SearchJsonQueryV2, SearchOrderByV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

const Page = Schema.Struct({
    data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    nextPageToken: Schema.optional(Schema.String),
});
const invalidResponse = (cause: unknown) =>
    new BackendError({
        operation: "foundry.loadSubset",
        kind: "InvalidResponse",
        message: "Foundry returned an invalid object page.",
        retryable: false,
        cause: Redacted.make(cause),
    });

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
            async (pageSize, pageToken: string | undefined) => {
                const result = await OntologyObjectsV2.search(requestClient, client.ontologyRid, objectType, {
                    snapshot: true,
                    where: options.where,
                    excludeRid: true,
                    select: selectedProperties,
                    selectV2: [],
                    pageSize,
                    pageToken,
                    orderBy: options.orderBy,
                });
                try {
                    return Schema.decodeUnknownSync(Page)(result);
                } catch (cause) {
                    throw invalidResponse(cause);
                }
            },
            (page) => page.nextPageToken,
            (page) => page.data,
            10_000,
            limit === undefined ? undefined : offset + limit
        )
    );
    options.signal?.throwIfAborted();
    try {
        return results.slice(offset, limit === undefined ? undefined : offset + limit).map(decodeObject);
    } catch (cause) {
        throw invalidResponse(cause);
    }
}
