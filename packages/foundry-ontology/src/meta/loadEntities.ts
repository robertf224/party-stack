import { ObjectTypesV2, OntologyValueTypes } from "@osdk/foundry.ontologies";
import { Schema } from "effect";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import { convertFoundryMetaValueType } from "./convertMetaValueType.js";
import { listObjectTypes } from "./listObjectTypes.js";
import { planMetaLookup } from "./planMetaLookup.js";
import type {
    GetOutgoingLinkTypesByObjectTypeRidBatchRequest,
    LinkTypeSideV2,
    ObjectTypeV2,
} from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type {
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    ValueType as MetaValueType,
} from "@party-stack/ontology-spec/meta";
import type { Filter } from "@party-stack/ontology-storage";

const missing = Schema.is(Schema.Struct({ statusCode: Schema.Literal(404) }));
async function ignoreMissing<A>(load: () => Promise<A>): Promise<A | undefined> {
    try {
        return await load();
    } catch (cause) {
        if (missing(cause)) return undefined;
        throw cause;
    }
}

export async function loadFoundryMetaObjectTypes(
    client: OntologyClient,
    predicate?: Filter
): Promise<MetaObjectType[]> {
    const lookup = planMetaLookup(predicate, { id: "id", name: "name" });
    let objectTypes: ObjectTypeV2[];
    if (!lookup) objectTypes = await listObjectTypes(client);
    else if (lookup.field === "name")
        objectTypes = await AsyncIterable.toArray(
            AsyncIterable.fromBatches(
                lookup.values,
                async (batch) =>
                    (
                        await ObjectTypesV2.getFullMetadataBatch(
                            client,
                            client.ontologyRid,
                            {
                                requests: batch.map((objectType) => ({ objectType })),
                                includeLinkTypes: false,
                            },
                            { preview: true }
                        )
                    ).data.map((metadata) => metadata.objectType),
                100
            )
        );
    else
        objectTypes = await AsyncIterable.toArray(
            AsyncIterable.fromBatches(
                lookup.values,
                async (batch) =>
                    (
                        await ObjectTypesV2.getByRidBatch(
                            client,
                            client.ontologyRid,
                            { requests: batch.map((objectTypeRid) => ({ objectTypeRid })) },
                            { preview: true }
                        )
                    ).data,
                100
            )
        );
    return objectTypes.map((objectType) => convertFoundryMetaObjectType({ objectType }));
}

export async function loadFoundryMetaLinkTypes(
    client: OntologyClient,
    predicate?: Filter
): Promise<MetaLinkType[]> {
    const lookup = planMetaLookup(predicate, {
        "source.objectType": "objectType",
        "target.objectType": "objectType",
    });
    // Outgoing sides of the selected object types, by API name. Foundry lists link types
    // per object type; the batch endpoints answer up to 100 object types per request.
    const outgoing = new Map<string, LinkTypeSideV2[]>();
    if (lookup) {
        const metadata = await AsyncIterable.toArray(
            AsyncIterable.fromBatches(
                [...new Set(lookup.values)],
                async (batch) =>
                    (
                        await ObjectTypesV2.getFullMetadataBatch(
                            client,
                            client.ontologyRid,
                            {
                                requests: batch.map((objectType) => ({ objectType })),
                                includeLinkTypes: true,
                            },
                            { preview: true }
                        )
                    ).data,
                100
            )
        );
        for (const { objectType, linkTypes } of metadata) outgoing.set(objectType.apiName, linkTypes);
    } else {
        const objectTypes = await listObjectTypes(client);
        const names = new Map(objectTypes.map((type) => [type.rid, type.apiName]));
        const sides = await AsyncIterable.toArray(
            AsyncIterable.fromBatches(
                [...names.keys()],
                async (batch) =>
                    Object.entries(
                        (
                            await ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch(
                                client,
                                client.ontologyRid,
                                // Omitting the filter returns every outgoing link type.
                                {
                                    requests: batch.map((objectTypeRid) => ({ objectTypeRid })),
                                } as GetOutgoingLinkTypesByObjectTypeRidBatchRequest,
                                { preview: true }
                            )
                        ).data
                    ),
                100
            )
        );
        for (const [rid, linkTypes] of sides) {
            const name = names.get(rid);
            if (name) outgoing.set(name, linkTypes);
        }
    }
    const selected = [...outgoing.values()];
    const selectedRids = new Set(selected.flatMap((sides) => sides.map((side) => side.linkTypeRid)));
    // A link needs both outgoing sides. Resolve only the unselected neighbors,
    // then ask the batch endpoint for the inverse sides of the selected links.
    const neighbors = [
        ...new Set(selected.flatMap((sides) => sides.map((side) => side.objectTypeApiName))),
    ].filter((name) => !outgoing.has(name));
    const neighborRids = await AsyncIterable.toArray(
        AsyncIterable.fromBatches(
            neighbors,
            async (batch) =>
                (
                    await ObjectTypesV2.getFullMetadataBatch(
                        client,
                        client.ontologyRid,
                        {
                            requests: batch.map((objectType) => ({ objectType })),
                            includeLinkTypes: false,
                        },
                        { preview: true }
                    )
                ).data.map((metadata) => metadata.objectType.rid),
            100
        )
    );
    const inverseSides = await AsyncIterable.toArray(
        AsyncIterable.fromBatches(
            [...new Set(neighborRids)],
            async (batch) =>
                Object.values(
                    (
                        await ObjectTypesV2.getOutgoingLinkTypesByObjectTypeRidBatch(
                            client,
                            client.ontologyRid,
                            {
                                requests: batch.map((objectTypeRid) => ({ objectTypeRid })),
                                filterLinkTypeRids: [...selectedRids],
                            },
                            { preview: true }
                        )
                    ).data
                ).flat(),
            100
        )
    );
    return convertFoundryMetaLinkTypes(
        [...selected, inverseSides].map((linkTypes) => ({
            linkTypes: linkTypes.filter((side) => selectedRids.has(side.linkTypeRid)),
        }))
    );
}

export async function loadFoundryMetaValueTypes(
    client: OntologyClient,
    predicate?: Filter
): Promise<MetaValueType[]> {
    const lookup = planMetaLookup(predicate, { name: "name" });
    const types = lookup
        ? await Promise.all(
              lookup.values.map((name) =>
                  ignoreMissing(() =>
                      OntologyValueTypes.get(client, client.ontologyRid, name, { preview: true })
                  )
              )
          )
        : (await OntologyValueTypes.list(client, client.ontologyRid, { preview: true })).data;
    return types.filter((type) => type !== undefined).map(convertFoundryMetaValueType);
}
