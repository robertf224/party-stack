export {
    localCollectionOptions,
    replicatedCollectionOptions,
    persistedCollectionOptions,
    makeLocalCollection,
    makeReplicatedCollection,
    scopedCollection,
} from "./collections.js";
export { createLocalCollection } from "./createLocalCollection.js";
export { storageSubset } from "./subset.js";
export { getCollectionDemands } from "./diagnostics.js";
export type { CollectionDemandDiagnostic } from "./diagnostics.js";
