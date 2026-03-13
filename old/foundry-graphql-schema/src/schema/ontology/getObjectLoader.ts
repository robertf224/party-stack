import {
    OntologyObjectsV2,
    PropertyApiName,
    ObjectTypeV2,
    SearchObjectsRequestV2,
} from "@osdk/foundry.ontologies";
import { LoadOneCallback, loadOneCallback } from "grafast";
import { FoundryContext } from "../context.js";
import { PrimaryKeyValue, TypedOntologyObject } from "../utils/TypedOntologyObject.js";

type ObjectLoader = LoadOneCallback<PrimaryKeyValue, TypedOntologyObject, {}, FoundryContext>;

const cache = new WeakMap<ObjectTypeV2, ObjectLoader>();

export function getObjectLoader(objectType: ObjectTypeV2): ObjectLoader {
    let loader = cache.get(objectType);
    if (loader) {
        return loader;
    }

    loader = loadOneCallback<PrimaryKeyValue, TypedOntologyObject, {}, FoundryContext>(
        async (ids, { attributes, unary: context }) => {
            // TODO: handle page sizes
            const { data } = await OntologyObjectsV2.search(
                context.client,
                context.ontologyRid,
                objectType.apiName,
                {
                    where: {
                        type: "in",
                        field: objectType.primaryKey,
                        value: ids as PrimaryKeyValue[],
                    },
                    pageSize: ids.length,
                    select: attributes as PropertyApiName[],
                    excludeRid: true,
                    // Leaving out selectV2
                } as SearchObjectsRequestV2
            );
            const objectsMap = Object.fromEntries(
                (data as TypedOntologyObject[]).map((object) => [object.__primaryKey, object])
            );
            return ids.map((id) => objectsMap[id]);
        }
    );

    cache.set(objectType, loader);
    return loader;
}
