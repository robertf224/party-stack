import { BackendError } from "@party-stack/ontology-backend";
import { connectOntologyHttp } from "@party-stack/ontology-server/rpc/http";
import { sqliteOntologyConformanceIR } from "@party-stack/ontology/testing/sqlite";
import { Bucket } from "alchemy/Cloudflare/R2/Bucket";
import { Secret } from "alchemy/Cloudflare/SecretsStore";
import { isDurableObjectExport } from "alchemy/Cloudflare/Workers/DurableObject";
import { DurableObjectState, fromDurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Worker, WorkerEnvironment } from "alchemy/Cloudflare/Workers/Worker";
import { makeWorkerRuntimeContext } from "alchemy/Cloudflare/Workers/WorkerRuntimeContext";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import { Redacted } from "effect";
import { ConfigProvider, Context, Effect, Result, type Scope } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { OntologyDurableObject } from "../src/alchemy/index.js";
import { withTestRuntime } from "./bindings.js";
import type { OntologyDurableObjectOptions } from "../src/alchemy/index.js";

// Alchemy's namespace Effect uses Worker as its requirement identifier while
// resolving the host through the resource's Self key at runtime.
class TestWorker extends Context.Service<Worker, Effect.Success<typeof Worker>>()(Worker.Self.key) {}

/** Exercise Alchemy's actual binding/export registration, deferring IO to its instance constructor.
 * The fake host captures declarations only; SQL, R2, alarm storage and RPC run in real workerd.
 */
const declare = Effect.fnUntraced(function* (bucket: R2Bucket, gc: OntologyDurableObjectOptions["gc"]) {
    const runtime = makeWorkerRuntimeContext("resource-test");
    const bindings: Array<{ bindings: readonly { type: string; name: string; className?: string }[] }> = [];
    const host = {
        ...runtime,
        durableObjectNamespaces: Output.literal({}),
        bind:
            () => (properties: { bindings: readonly { type: string; name: string; className?: string }[] }) =>
                Effect.sync(() => {
                    bindings.push(properties);
                }),
    };
    const stack: Context.Service.Shape<typeof Stack> = {
        name: "resource-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
    };
    const resource = OntologyDurableObject("ResourceNotes", {
        ir: sqliteOntologyConformanceIR,
        bucket: Bucket.ref("BLOBS"),
        gc,
        ...(gc === false
            ? {
                  encryptionKeys: {
                      active: "v2",
                      secrets: {
                          v1: Secret("ExternalOldKey", {
                              store: { storeId: "test", accountId: "test" },
                              value: Redacted.make("ab".repeat(32)),
                          }),
                          v2: Secret("ExternalNewKey", {
                              store: { storeId: "test", accountId: "test" },
                              value: Redacted.make("cd".repeat(32)),
                          }),
                      },
                  },
              }
            : {}),
        context: { user: "tester" },
        authorize: (_request, headers) =>
            headers.authorization === "Bearer test"
                ? Effect.void
                : Effect.fail(
                      new BackendError({
                          operation: "authorize",
                          kind: "Forbidden",
                          message: "Denied",
                          retryable: false,
                      })
                  ),
    });
    let secretReads = 0;
    const namespace = yield* resource.pipe(
        Effect.provideService(TestWorker, host as unknown as Effect.Success<typeof Worker>),
        Effect.provideService(WorkerEnvironment, {
            BLOBS: bucket,
            ExternalOldKey: {
                get: async () => {
                    secretReads++;
                    return "ab".repeat(32);
                },
            },
            ExternalNewKey: {
                get: async () => {
                    secretReads++;
                    return "cd".repeat(32);
                },
            },
            ResourceNotesEncryptionKey: {
                get: async () => {
                    secretReads++;
                    return "ab".repeat(32);
                },
            },
        }),
        Effect.provideService(Stack, stack),
        Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" })
        )
    );
    const exports = yield* runtime.exports;
    const exported = exports.ResourceNotes;
    if (!isDurableObjectExport(exported))
        throw new Error("Factory did not register a Durable Object export.");
    return {
        namespace,
        exported,
        bindings,
        encryptionConfigured: () => secretReads === (gc === false ? 4 : 2),
    };
});

export interface ResourceResult {
    name: string;
    bindingRegistered: boolean;
    schemaDeferred: boolean;
    encryptionConfigured: boolean;
    denied: boolean;
    firstAlarm: boolean;
    scheduled: boolean;
    preservedAlarm: boolean;
    orphanCollected: boolean;
    content: string;
    title: unknown;
}
export const runOntologyResource: (
    state: Parameters<typeof fromDurableObjectState>[0],
    bucket: R2Bucket,
    disabled: boolean
) => Effect.Effect<ResourceResult, BackendError, Scope.Scope> = Effect.fnUntraced(function* (
    state: Parameters<typeof fromDurableObjectState>[0],
    bucket: R2Bucket,
    disabled: boolean
) {
    const definition = yield* declare(
        bucket,
        disabled ? false : { intervalMs: 60_000, orphanGraceMs: 0, limit: 10 }
    );
    const schemaBefore = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'party_tables_rows'")
        .toArray();
    const earlier = Date.now() + 30_000;
    if (!disabled) yield* Effect.promise(() => state.storage.setAlarm(earlier));
    const construct = definition.exported.constructor.pipe(
        Effect.provideService(DurableObjectState, fromDurableObjectState(state)),
        Effect.provideContext(definition.exported.services)
    );
    const inner = yield* construct;
    const shape = yield* withTestRuntime(
        inner.pipe(Effect.provideService(DurableObjectState, fromDurableObjectState(state))),
        bucket
    );
    const firstAlarm = yield* Effect.promise(() => state.storage.getAlarm());
    const fetch = HttpEffect.toWebHandler(
        withTestRuntime(
            shape.fetch!.pipe(Effect.provideService(DurableObjectState, fromDurableObjectState(state))),
            bucket
        )
    );
    const connect = (token: string) =>
        connectOntologyHttp({ url: "https://resource.test/rpc" }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
                const request = new Request(input, init);
                request.headers.set("authorization", `Bearer ${token}`);
                return fetch(request);
            })
        );
    const denied = yield* Effect.result(connect("wrong"));
    const client = yield* connect("test");
    if (client.replication.kind !== "committed")
        return yield* new BackendError({
            operation: "test",
            kind: "Internal",
            message: "Owned server advertised speculative state.",
            retryable: false,
        });
    const create = {
        id: "create",
        name: "createNote",
        parameters: { id: "one", title: "Resource factory", owner: "tester" },
    };
    const receipt = yield* client.backend.applyAction(create);
    const repeated = yield* client.backend.applyAction(create);
    if (JSON.stringify(receipt) !== JSON.stringify(repeated))
        return yield* new BackendError({
            operation: "test",
            kind: "Internal",
            message: "A repeated action did not recover its receipt.",
            retryable: false,
        });
    const orphan = yield* Effect.promise(() =>
        client.operations.attachments.create(new Blob(["orphan"]), { id: "orphan" })
    );
    const retained = yield* Effect.promise(() =>
        client.operations.attachments.create(new Blob(["retained"]), { id: "retained" })
    );
    yield* client.backend.applyAction({
        id: "asset",
        name: "createAsset",
        parameters: { id: "asset", attachment: retained.attachment },
    });
    if (shape.alarm) yield* withTestRuntime(shape.alarm(), bucket);
    const afterAlarm = yield* Effect.promise(() => state.storage.getAlarm());
    const readOrphan = yield* Effect.result(
        Effect.tryPromise(() => client.operations.attachments.blob(orphan.attachment))
    );
    const content = yield* Effect.promise(async () =>
        (await client.operations.attachments.blob(retained.attachment)).text()
    );
    // A second activation must reuse durable rows and leave a scheduled alarm untouched.
    const reopened = yield* withTestRuntime(
        (yield* construct).pipe(Effect.provideService(DurableObjectState, fromDurableObjectState(state))),
        bucket
    );
    const secondAlarm = yield* Effect.promise(() => state.storage.getAlarm());
    const reopenedFetch = HttpEffect.toWebHandler(
        withTestRuntime(
            reopened.fetch!.pipe(Effect.provideService(DurableObjectState, fromDurableObjectState(state))),
            bucket
        )
    );
    const restored = yield* connectOntologyHttp({ url: "https://resource.test/rpc" }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
            const request = new Request(input, init);
            request.headers.set("authorization", "Bearer test");
            return reopenedFetch(request);
        })
    );
    const snapshot = yield* restored.backend.loadSubset({ objectType: "Note" });
    return {
        encryptionConfigured: definition.encryptionConfigured(),
        name: definition.namespace.name,
        bindingRegistered: definition.bindings.some((registration) =>
            registration.bindings.some(
                (binding) =>
                    binding.type === "durable_object_namespace" &&
                    binding.name === "ResourceNotes" &&
                    binding.className === "ResourceNotes"
            )
        ),
        schemaDeferred: schemaBefore.length === 0,
        denied: Result.isFailure(denied) && denied.failure.kind === "Forbidden",
        firstAlarm: disabled ? firstAlarm === null : firstAlarm === earlier,
        scheduled: disabled ? afterAlarm === null : afterAlarm !== null && afterAlarm >= earlier,
        preservedAlarm: secondAlarm === afterAlarm,
        orphanCollected: Result.isFailure(readOrphan),
        content,
        title: snapshot.rows[0]?.value.title,
    };
});
