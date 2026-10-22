import { makeHelpers } from "alchemy/Cloudflare/R2/BucketBinding";
import { makeReadWrite } from "alchemy/Cloudflare/R2/ReadWriteBucketBinding";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect } from "effect";
import type { Bucket } from "alchemy/Cloudflare/R2/Bucket";

// Test-only resource descriptor: the normal Alchemy deployment creates this binding.
export const testBucket = (bucket: R2Bucket) =>
    makeReadWrite(makeHelpers({ BLOBS: bucket }, { LogicalId: "BLOBS" } as Bucket));
export const withTestRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>, bucket: R2Bucket) =>
    effect.pipe(
        Effect.provideService(RuntimeContext, {
            Type: "Cloudflare.Worker",
            id: "storage-test",
            env: { BLOBS: bucket },
            get: () => Effect.succeed(undefined),
            set: (id) => Effect.succeed(id),
        })
    );
