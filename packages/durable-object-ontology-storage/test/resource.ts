import { BackendError } from "@party-stack/ontology-backend";
import { connectOntologyHttp } from "@party-stack/ontology-server/rpc/http";
import { sqliteOntologyConformanceIR } from "@party-stack/ontology/testing/sqlite";
import { Bucket } from "alchemy/Cloudflare/R2/Bucket";
import { isDurableObjectExport } from "alchemy/Cloudflare/Workers/DurableObject";
import { DurableObjectState, fromDurableObjectState } from "alchemy/Cloudflare/Workers/DurableObjectState";
import { Worker, WorkerEnvironment } from "alchemy/Cloudflare/Workers/Worker";
import { makeWorkerRuntimeContext } from "alchemy/Cloudflare/Workers/WorkerRuntimeContext";
import * as Output from "alchemy/Output";
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
    const resource = OntologyDurableObject("ResourceNotes", {
        ir: sqliteOntologyConformanceIR,
        bucket: Bucket.ref("BLOBS"),
        gc,
        context: { user: "tester" },
        authorize: (_request, headers) =>
            headers.authorization === "Bearer test"
                ? Effect.void
                : Effect.fail(
                      new BackendError({
                          operation: "authorize",
                          kind: "Rejected",
                          message: "Denied",
                          retryable: false,
                      })
                  ),
    });
    const namespace = yield* resource.pipe(
        // Test-only partial host: these are the binding/export capabilities the SDK invokes.
        Effect.provideService(TestWorker, host as unknown as Effect.Success<typeof Worker>),
        Effect.provideService(WorkerEnvironment, { BLOBS: bucket }),
        Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" })
        )
    );
    const exports = yield* runtime.exports;
    const exported = exports.ResourceNotes;
    if (!isDurableObjectExport(exported))
        throw new Error("Factory did not register a Durable Object export.");
    return { namespace, exported, bindings };
});

export interface ResourceResult {
    name: string;
    bindingRegistered: boolean;
    schemaDeferred: boolean;
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
    const session = yield* client.openClient();
    yield* client.submit({
        session,
        sequence: 1,
        optimistic: false,
        invocation: {
            id: "create",
            name: "createNote",
            parameters: { id: "one", title: "Resource factory", owner: "tester" },
        },
    });
    const orphan = yield* Effect.promise(() =>
        client.operations.attachments.create(new Blob(["orphan"]), { id: "orphan" })
    );
    const retained = yield* Effect.promise(() =>
        client.operations.attachments.create(new Blob(["retained"]), { id: "retained" })
    );
    yield* client.submit({
        session,
        sequence: 2,
        optimistic: false,
        invocation: {
            id: "asset",
            name: "createAsset",
            parameters: { id: "asset", attachment: retained.attachment },
        },
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
    const snapshot = yield* restored.read(yield* restored.openClient());
    return {
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
        denied: Result.isFailure(denied) && denied.failure.kind === "Rejected",
        firstAlarm: disabled ? firstAlarm === null : firstAlarm === earlier,
        scheduled: disabled ? afterAlarm === null : afterAlarm !== null && afterAlarm >= earlier,
        preservedAlarm: secondAlarm === afterAlarm,
        orphanCollected: Result.isFailure(readOrphan),
        content,
        title: snapshot.state.objects.find((object) => object.objectType === "Note")?.base[0]?.value.title,
    };
});
