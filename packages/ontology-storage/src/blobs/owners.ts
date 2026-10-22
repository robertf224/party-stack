import { Effect } from "effect";
import type { BlobStorageOptions } from "./index.js";

const owners = new WeakMap<object, Set<string>>();

/** Use only when the platform guarantees exclusive process ownership, e.g. a DO incarnation.
 * Unknown owners then belong to a dead incarnation; an elapsed timeout is not proof of death.
 */
export function exclusiveOwnerLiveness(
    identity: object
): Pick<BlobStorageOptions, "registerOwner" | "isOwnerAlive"> {
    let live = owners.get(identity);
    if (!live) {
        live = new Set();
        owners.set(identity, live);
    }
    const current = live;
    return {
        registerOwner: (owner) =>
            Effect.acquireRelease(
                Effect.sync(() => {
                    current.add(owner);
                }),
                () =>
                    Effect.sync(() => {
                        current.delete(owner);
                    })
            ),
        isOwnerAlive: (owner) => Effect.sync(() => current.has(owner)),
    };
}
