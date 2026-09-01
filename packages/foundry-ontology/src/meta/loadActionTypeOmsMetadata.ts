import { ontologyMetadataApi } from "@bobbyfidz/oms";
import { DefaultHttpApiBridge } from "conjure-client";
import type { OntologyClient } from "@party-stack/foundry-client";

const ONTOLOGY_METADATA_API_PATH = "ontology-metadata/api";
const OMS_BULK_LOAD_LIMIT = 100;

export type ActionTypeOmsMetadata = ontologyMetadataApi.IActionType;

function createOntologyMetadataService(
    client: OntologyClient
): ontologyMetadataApi.IOntologyMetadataService {
    const baseUrl = new URL(
        ONTOLOGY_METADATA_API_PATH,
        `${new URL(client.baseUrl).origin}/`
    ).toString();
    return new ontologyMetadataApi.OntologyMetadataService(
        new DefaultHttpApiBridge({
            baseUrl,
            userAgent: {
                productName: "party-stack",
                productVersion: "0.0.0",
            },
            token: client.tokenProvider,
            fetch: client.fetch,
        })
    );
}

export async function loadActionTypeOmsMetadata(
    client: OntologyClient,
    actionTypeRids: string[]
): Promise<Map<string, ActionTypeOmsMetadata>> {
    const metadata = new Map<string, ActionTypeOmsMetadata>();
    const service = createOntologyMetadataService(client);

    for (let index = 0; index < actionTypeRids.length; index += OMS_BULK_LOAD_LIMIT) {
        const rids = actionTypeRids.slice(index, index + OMS_BULK_LOAD_LIMIT);
        try {
            const response = await service.bulkLoadOntologyEntities({
                actionTypes: rids.map((rid) => ({ rid })),
                datasourceTypes: [],
                linkTypes: [],
                objectTypes: [],
                sharedPropertyTypes: [],
                interfaceTypes: [],
                typeGroups: [],
            });
            response.actionTypes.forEach((result, resultIndex) => {
                const rid = rids[resultIndex];
                if (rid && result?.actionType) {
                    metadata.set(rid, result.actionType);
                }
            });
        } catch {
            // OMS is an unstable/private compatibility API. Public action
            // metadata must remain usable when this endpoint is unavailable.
        }
    }

    return metadata;
}
