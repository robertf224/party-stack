import { objectMatchesFilter } from "./objectMatchesFilter";
import type {
    ObjectOrInterfaceDefinition,
    Osdk,
    WhereClause,
    ObjectSet as ObjectSetClient,
    ObjectTypeDefinition,
} from "@osdk/api";
import type { Client } from "@osdk/client";

export interface ObjectSet<T extends ObjectOrInterfaceDefinition> {
    type: T;
    filter?: WhereClause<T>;
}

function normalize<T extends ObjectOrInterfaceDefinition>(
    objectSet: ObjectSet<T>,
    object: Osdk<ObjectTypeDefinition>
): Osdk<T> | undefined {
    try {
        // We're relying on $as throwing errors here which is janky
        // https://github.com/palantir/osdk-ts/blob/c70821e7f5c13826a5e3f2b86b6bacf0bb3f909e/packages/client/src/object/convertWireToOsdkObjects/getDollarAs.ts#L60
        return object.$as(objectSet.type.apiName) as unknown as Osdk<T>;
    } catch {
        return undefined;
    }
}
function contains<T extends ObjectOrInterfaceDefinition>(objectSet: ObjectSet<T>, object: Osdk<T>): boolean {
    return objectSet.filter ? objectMatchesFilter(object, objectSet.filter) : true;
}

function toOSDK<T extends ObjectOrInterfaceDefinition>(
    objectSet: ObjectSet<T>,
    client: Client
): ObjectSetClient<T> {
    // Getting a type error like `Type 'ObjectTypeDefinition' is not assignable to type 'Experiment<"2.0.8"> | Experiment<"2.1.0">'.`
    // think something needs to get fixed upstream.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectSetClient = client(objectSet.type as any) as ObjectSetClient<T>;
    return objectSet.filter ? objectSetClient.where(objectSet.filter) : objectSetClient;
}

export const ObjectSet = {
    normalize,
    contains,
    toOSDK,
};
