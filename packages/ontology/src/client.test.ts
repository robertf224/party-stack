import { BackendError } from "@party-stack/ontology-backend";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { createOntologyClient } from "./client.js";

test("the Promise client facade owns one transport and cleanup is idempotent", async () => {
    let opened = 0,
        closed = 0;
    const client = await createOntologyClient(
        Effect.acquireRelease(
            Effect.sync(() => {
                opened++;
                return { ontology: () => Effect.die("Not used") };
            }),
            () =>
                Effect.sync(() => {
                    closed++;
                })
        )
    );
    expect({ opened, closed }).toEqual({ opened: 1, closed: 0 });
    await Promise.all([client.cleanup(), client.cleanup()]);
    expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
});

test("failed client startup releases already acquired transport resources", async () => {
    let closed = false;
    await expect(
        createOntologyClient(
            Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        closed = true;
                    })
                );
                return yield* new BackendError({
                    operation: "connect",
                    kind: "Unavailable",
                    retryable: true,
                    message: "Offline",
                });
            })
        )
    ).rejects.toThrow("Offline");
    expect(closed).toBe(true);
});
