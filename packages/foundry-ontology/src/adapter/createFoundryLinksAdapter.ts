import { LinkedObjectsV2, type OntologyObjectV2 } from "@osdk/foundry.ontologies";
import {
    normalizeFoundryError,
    isFoundryNotFoundError,
    type OntologyClient,
} from "@party-stack/foundry-client";
import {
    OntologyLinkError,
    resolveOntologyLink,
    type OntologyGetLinkOpts,
    type OntologyIR,
    type OntologyLinkedObject,
    type OntologyLinkPage,
    type OntologyLinksAdapter,
    type OntologyListLinksOpts,
} from "@party-stack/ontology";
import type { FoundryCodec } from "./foundryCodec.js";

function escapePrimaryKey(primaryKey: string | number): string {
    return encodeURIComponent(String(primaryKey));
}

function requireObjectType(ir: OntologyIR, objectType: string) {
    const def = ir.objectTypes.find((candidate) => candidate.name === objectType);
    if (!def) {
        throw new OntologyLinkError(`Unknown object type "${objectType}".`);
    }
    return def;
}

function selectedProperties(
    ir: OntologyIR,
    objectType: string,
    primaryKey: string,
    select?: string[]
): string[] {
    const selected =
        select ??
        ir.objectTypes
            .find((candidate) => candidate.name === objectType)
            ?.properties.map((property) => property.name) ??
        [];
    return Array.from(new Set([primaryKey, ...selected]));
}

function toLinkedObject(
    codec: FoundryCodec,
    objectType: string,
    primaryKeyProperty: string,
    raw: OntologyObjectV2
): OntologyLinkedObject {
    const properties = codec.decodeObject(objectType, raw);
    const primaryKey = properties[primaryKeyProperty];
    if (typeof primaryKey !== "string" && typeof primaryKey !== "number") {
        throw new OntologyLinkError(
            `Linked ${objectType} object is missing primary key property "${primaryKeyProperty}".`
        );
    }
    return {
        objectType,
        primaryKey,
        properties,
    };
}

export function createFoundryLinksAdapter(opts: {
    client: OntologyClient;
    ir: OntologyIR;
    codec: FoundryCodec;
}): OntologyLinksAdapter {
    return {
        list: async (listOpts: OntologyListLinksOpts): Promise<OntologyLinkPage> => {
            const resolved = resolveOntologyLink(opts.ir, listOpts.objectType, listOpts.link);
            const target = requireObjectType(opts.ir, resolved.targetObjectType);
            const select = selectedProperties(
                opts.ir,
                resolved.targetObjectType,
                target.primaryKey,
                listOpts.select
            );

            try {
                const response = await LinkedObjectsV2.listLinkedObjects(
                    opts.client,
                    opts.client.ontologyRid,
                    listOpts.objectType,
                    escapePrimaryKey(listOpts.primaryKey),
                    resolved.sideName,
                    {
                        pageSize: listOpts.pageSize,
                        pageToken: listOpts.pageToken,
                        select,
                    }
                );

                return {
                    objects: response.data.map((object) =>
                        toLinkedObject(opts.codec, resolved.targetObjectType, target.primaryKey, object)
                    ),
                    nextPageToken: response.nextPageToken,
                };
            } catch (error) {
                const normalized = normalizeFoundryError(error);
                if (isFoundryNotFoundError(normalized)) {
                    throw new OntologyLinkError(
                        `Link "${listOpts.objectType}.${resolved.sideName}" was not found for primary key "${listOpts.primaryKey}".`,
                        { cause: normalized }
                    );
                }
                throw normalized;
            }
        },
        get: async (getOpts: OntologyGetLinkOpts): Promise<OntologyLinkedObject | undefined> => {
            const resolved = resolveOntologyLink(opts.ir, getOpts.objectType, getOpts.link);
            const target = requireObjectType(opts.ir, resolved.targetObjectType);
            const select = selectedProperties(
                opts.ir,
                resolved.targetObjectType,
                target.primaryKey,
                getOpts.select
            );

            if (getOpts.linkedPrimaryKey !== undefined) {
                try {
                    const object = await LinkedObjectsV2.getLinkedObject(
                        opts.client,
                        opts.client.ontologyRid,
                        getOpts.objectType,
                        escapePrimaryKey(getOpts.primaryKey),
                        resolved.sideName,
                        escapePrimaryKey(getOpts.linkedPrimaryKey),
                        { select }
                    );
                    return toLinkedObject(opts.codec, resolved.targetObjectType, target.primaryKey, object);
                } catch (error) {
                    const normalized = normalizeFoundryError(error);
                    if (isFoundryNotFoundError(normalized)) {
                        return undefined;
                    }
                    throw normalized;
                }
            }

            if (resolved.cardinality === "many") {
                throw new OntologyLinkError(
                    `Link "${getOpts.objectType}.${resolved.sideName}" is to-many; use links.list().`
                );
            }

            let response: { data: OntologyObjectV2[] };
            try {
                response = await LinkedObjectsV2.listLinkedObjects(
                    opts.client,
                    opts.client.ontologyRid,
                    getOpts.objectType,
                    escapePrimaryKey(getOpts.primaryKey),
                    resolved.sideName,
                    {
                        pageSize: 2,
                        select,
                    }
                );
            } catch (error) {
                const normalized = normalizeFoundryError(error);
                if (isFoundryNotFoundError(normalized)) {
                    return undefined;
                }
                throw normalized;
            }

            if (response.data.length > 1) {
                throw new OntologyLinkError(
                    `Expected at most one linked object for "${getOpts.objectType}.${resolved.sideName}" but Foundry returned ${response.data.length}.`
                );
            }

            const raw = response.data[0];
            return raw
                ? toLinkedObject(opts.codec, resolved.targetObjectType, target.primaryKey, raw)
                : undefined;
        },
    };
}
