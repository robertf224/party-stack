import * as AsyncIterable from "../utils/AsyncIterable.js";
import { buildSoqlQuery } from "./soql.js";
import type { CompiledSoqlFilter } from "./soql.js";
import type { SalesforceClient } from "@party-stack/salesforce-client";

type SalesforceObject = Record<string, unknown>;

/** Shared SOQL transport; query compilation and collection materialization live outside it. */
export async function searchSalesforceObjects(
    client: SalesforceClient,
    objectType: string,
    selectedProperties: string[],
    opts: {
        where?: CompiledSoqlFilter;
        orderBy?: string;
        offset?: number;
        limit?: number;
        signal?: AbortSignal;
    },
    decodeObject: (object: SalesforceObject) => SalesforceObject = (object) => object
): Promise<SalesforceObject[]> {
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = opts.limit === undefined ? undefined : Math.max(0, Math.trunc(opts.limit));
    if (limit === 0 || opts.where?.alwaysFalse) return [];
    if (opts.signal) client = client.withSignal?.(opts.signal) ?? client;
    // Salesforce OFFSET max is 2000. Prefer locator pagination for deep reads and
    // only push OFFSET when the caller requested a small local window.
    const canPushOffset = offset > 0 && offset <= 2000 && (limit === undefined || offset + limit <= 2000);
    const soql = buildSoqlQuery({
        objectType,
        selectedProperties,
        where: opts.where,
        orderBy: opts.orderBy,
        limit: canPushOffset
            ? limit === undefined
                ? undefined
                : offset + limit
            : limit === undefined
              ? undefined
              : offset + limit,
        offset: canPushOffset ? offset : undefined,
    });

    const results = await AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            async (_pageSize, pageToken: string | undefined) => {
                opts.signal?.throwIfAborted();
                const page = await (pageToken
                    ? client.queryMore<SalesforceObject>(pageToken)
                    : client.query<SalesforceObject>(soql));
                if (!page.done && !page.nextRecordsUrl)
                    throw new Error("Salesforce returned an incomplete page without a query locator.");
                return page;
            },
            (page) => (page.done ? undefined : page.nextRecordsUrl),
            (page) => page.records,
            2_000,
            canPushOffset
                ? limit === undefined
                    ? undefined
                    : limit
                : limit === undefined
                  ? undefined
                  : offset + limit
        )
    );

    const sliced = canPushOffset
        ? results
        : results.slice(offset, limit === undefined ? undefined : offset + limit);

    return sliced.map(decodeObject);
}
