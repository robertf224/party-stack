import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import { Predicate as EffectPredicate, Schema } from "effect";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

/** Portable provider input. Full selections are rejected instead of silently discarded. */
export const ObjectSubsetSchema = Schema.declare<ObjectSubset>(
    (input): input is ObjectSubset =>
        EffectPredicate.isObject(input) &&
        !Object.hasOwn(input, "select") &&
        Schema.is(QueryDocumentSchema)({
            select: [
                {
                    kind: "sub",
                    value: { name: "objects", cardinality: "many", query: { ...input, select: [] } },
                },
            ],
        })
);
export const ObjectSelectionSchema = Schema.Struct({ subsets: Schema.Array(ObjectSubsetSchema) });
