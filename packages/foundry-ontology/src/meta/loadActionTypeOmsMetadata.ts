import { bulkLoadOntologyEntities } from "@osdk/client.unstable";
import type { OntologyClient } from "@party-stack/foundry-client";

const ONTOLOGY_METADATA_API_PATH = "/ontology-metadata/api";
const OMS_BULK_LOAD_LIMIT = 100;

type BulkLoadResponse = Awaited<
    ReturnType<typeof bulkLoadOntologyEntities>
>;
export type ActionTypeOmsMetadata = NonNullable<
    NonNullable<BulkLoadResponse["actionTypes"][number]>["actionType"]
>;

export async function loadActionTypeOmsMetadata(
    client: OntologyClient,
    actionTypeRids: string[]
): Promise<Map<string, ActionTypeOmsMetadata>> {
    const metadata = new Map<string, ActionTypeOmsMetadata>();
    const context = {
        baseUrl: new URL(client.baseUrl).origin,
        servicePath: ONTOLOGY_METADATA_API_PATH,
        tokenProvider: client.tokenProvider,
        fetchFn: client.fetch,
    };

    for (let index = 0; index < actionTypeRids.length; index += OMS_BULK_LOAD_LIMIT) {
        const rids = actionTypeRids.slice(index, index + OMS_BULK_LOAD_LIMIT);
        try {
            const response = await bulkLoadOntologyEntities(
                context,
                undefined,
                {
                    actionTypes: rids.map((rid) => ({ rid })),
                    datasourceTypes: [],
                    linkTypes: [],
                    objectTypes: [],
                    sharedPropertyTypes: [],
                    interfaceTypes: [],
                    typeGroups: [],
                }
            );
            response.actionTypes.forEach((result, resultIndex) => {
                const rid = rids[resultIndex];
                if (rid && result?.actionType) {
                    metadata.set(rid, result.actionType);
                }
            });
        } catch (error) {
            // OMS is an unstable/private compatibility API. Public action
            // metadata must remain usable when this endpoint is unavailable.
            console.warn(
                "Failed to load Foundry OMS action metadata; continuing with public metadata.",
                error
            );
        }
    }

    return metadata;
}
