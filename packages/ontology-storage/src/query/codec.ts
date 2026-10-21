import { Schema } from "effect";
import { validateQuery } from "./evaluate.js";
import type { Query } from "../model.js";

/** Reuses the planner/compiler's shape and scalar validation at wire boundaries. */
export const QuerySchema = Schema.declare<Query>((input): input is Query => {
    try {
        validateQuery(input as Query);
        return true;
    } catch {
        return false;
    }
}).annotate({ expected: "a portable storage query" });
