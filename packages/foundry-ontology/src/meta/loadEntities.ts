import { ObjectTypesV2, OntologyValueTypes } from "@osdk/foundry.ontologies";
import { Schema } from "effect";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import { convertFoundryMetaValueType } from "./convertMetaValueType.js";
import { listObjectTypes } from "./listObjectTypes.js";
import { planMetaLookup } from "./planMetaLookup.js";
import type { LinkTypeSideV2, ObjectTypeV2 } from "@osdk/foundry.ontologies";
import type { OntologyClient } from "@party-stack/foundry-client";
import type {
    LinkType as MetaLinkType,
    ObjectType as MetaObjectType,
    ValueType as MetaValueType,
} from "@party-stack/ontology-spec/meta";
import type { Predicate } from "@party-stack/ontology-storage";

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
    predicate?: Predicate
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
    predicate?: Predicate
): Promise<MetaLinkType[]> {
    const lookup = planMetaLookup(predicate, {
        "source.objectType": "objectType",
        "target.objectType": "objectType",
    });
    const names = lookup?.values ?? (await listObjectTypes(client)).map((type) => type.apiName);
    // Sharing is scoped to this load. Refreshes must acquire new provider metadata.
    const outgoing = new Map<string, Promise<LinkTypeSideV2[]>>();
    const load = (name: string) => {
        let result = outgoing.get(name);
        if (!result) {
            result = AsyncIterable.toArray(
                AsyncIterable.fromPagination(
                    (pageSize, pageToken: string | undefined) =>
                        pageToken === undefined
                            ? ignoreMissing(() =>
                                  ObjectTypesV2.listOutgoingLinkTypes(client, client.ontologyRid, name, {
                                      pageSize,
                                      pageToken,
                                  })
                              )
                            : ObjectTypesV2.listOutgoingLinkTypes(client, client.ontologyRid, name, {
                                  pageSize,
                                  pageToken,
                              }),
                    (page) => page?.nextPageToken,
                    (page) => page?.data ?? [],
                    100
                )
            );
            outgoing.set(name, result);
        }
        return result;
    };
    const selected = await Promise.all([...new Set(names)].map(load));
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
    predicate?: Predicate
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
