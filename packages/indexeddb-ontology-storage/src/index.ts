import { OntologyStorage, makeOntologyStorage, type StorageModel } from "@party-stack/ontology-storage";
import { Effect, Layer } from "effect";
import * as Tables from "./tables.js";

export const make = (model: StorageModel, options: { readonly databaseName: string }) =>
    Effect.map(Tables.make(options), (tables) => makeOntologyStorage(model, tables));
/** Supply the IndexedDb platform layer for this driver. */
export const layer = (model: StorageModel, options: { readonly databaseName: string }) =>
    Layer.effect(OntologyStorage, make(model, options));
