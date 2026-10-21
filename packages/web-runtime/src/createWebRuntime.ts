import { createRuntimeAdapter } from "@party-stack/runtime";
import { layer, type WebRuntimeOptions } from "./WebRuntime.js";

/** Promise boundary for installations; acquisition and cleanup use the platform Layer. */
export const createWebRuntime = (
    owner: string,
    namespace: string,
    options?: Omit<WebRuntimeOptions, "owner" | "namespace">
) => createRuntimeAdapter(layer({ ...options, owner, namespace }));
