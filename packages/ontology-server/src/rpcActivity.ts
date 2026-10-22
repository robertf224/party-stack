import { Context } from "effect";

/** Stream lifetime alone cannot distinguish subscriptions from finite byte transfers. */
export const RpcActivity = Context.Reference<"subscription" | "transfer">(
    "@party-stack/ontology-server/RpcActivity",
    { defaultValue: () => "subscription" }
);
