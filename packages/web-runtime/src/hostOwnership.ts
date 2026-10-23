import { RuntimeError } from "@party-stack/runtime";
import { Effect } from "effect";
import { createActorLiveness } from "./actorLiveness.js";

/** A persistent replica has one owner for its entire Scope. Waiting is interruptible;
 * closing the Scope or terminating the browser context releases the native lock.
 */
export const acquireHost = (namespace: string) =>
    createActorLiveness(namespace)
        .acquire("replica-host")
        .pipe(
            Effect.mapError((cause) =>
                cause instanceof RuntimeError
                    ? cause
                    : new RuntimeError({ operation: "webRuntime.ownership", cause })
            )
        );
