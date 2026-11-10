import { OntologyStorage, makeOntologyStorage, type StorageModel } from "@party-stack/ontology-storage";
import { Effect, Layer } from "effect";
import * as Tables from "./tables.js";

export const make = (model: StorageModel, options?: { readonly prefix?: string }) =>
    Effect.map(Tables.make(options), (tables) => makeOntologyStorage(model, tables));
export const layer = (model: StorageModel, options?: { readonly prefix?: string }) =>
    Layer.effect(OntologyStorage, make(model, options));
