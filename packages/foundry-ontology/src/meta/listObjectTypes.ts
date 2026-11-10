import { ObjectTypesV2 } from "@osdk/foundry.ontologies";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import type { ObjectTypeV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";

export async function listObjectTypes(client: OntologyClient): Promise<ObjectTypeV2[]> {
    return AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                ObjectTypesV2.list(client, client.ontologyRid, { pageSize, pageToken }),
            (page) => page.nextPageToken,
            (page) => page.data,
            100
        )
    );
}
