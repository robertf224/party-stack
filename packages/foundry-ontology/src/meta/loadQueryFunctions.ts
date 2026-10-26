import { QueryTypes, type QueryTypeV2 } from "@osdk/foundry.ontologies";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import type { OntologyClient } from "@party-stack/foundry-client";

export async function listQueryFunctionTypes(opts: { client: OntologyClient }): Promise<QueryTypeV2[]> {
    return AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                QueryTypes.list(opts.client, opts.client.ontologyRid, {
                    pageSize,
                    pageToken,
                }),
            (page) => page.nextPageToken,
            (page) => page.data,
            100
        )
    );
}

export async function getQueryFunctionTypes(
    opts: { client: OntologyClient },
    names: string[]
): Promise<QueryTypeV2[]> {
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) return [];
    return Promise.all(uniqueNames.map((name) => QueryTypes.get(opts.client, opts.client.ontologyRid, name)));
}
