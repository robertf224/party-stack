import { Effect, Layer } from "effect";
import { OntologyStorage, makeOntologyStorage, type StorageModel } from "../index.js";
import * as Tables from "./tables.js";

export const make = (model: StorageModel) =>
    Effect.map(Tables.make(), (tables) => makeOntologyStorage(model, tables));
export const layer = (model: StorageModel) => Layer.effect(OntologyStorage, make(model));
