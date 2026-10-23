import { make } from "./WebRuntime.js";
import type { WebRuntimeOptions } from "./WebRuntime.js";

export const createWebRuntime = (
    owner: string,
    namespace: string,
    options: Omit<WebRuntimeOptions, "owner" | "namespace"> = {}
) => make({ ...options, owner, namespace });
