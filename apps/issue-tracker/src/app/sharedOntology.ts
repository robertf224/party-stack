import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import {
    createLiveOntology,
    executeTransactionMutator,
    makeReplicaOntologyView,
} from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeReplica } from "@party-stack/ontology-replica";
import { connectOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Runtime, createRuntimeTraces } from "@party-stack/runtime";
import * as WebRuntime from "@party-stack/web-runtime";
import { Context, Effect, Layer, ManagedRuntime, Tracer } from "effect";
import type { CreateOntologyBackendInstallationOptions, LiveOntology } from "@party-stack/ontology";

type OpenOptions = Parameters<NonNullable<CreateOntologyBackendInstallationOptions["openOntology"]>>[0];

/** Each application partition has one persistent owner and an isolated tab view. */
export async function openSharedOntology(options: OpenOptions): Promise<LiveOntology> {
    if (typeof SharedWorker === "undefined") return createLiveOntology(options);
    const partition = {
        installationId: options.installationId,
        userId: options.userId,
        ontologyId: options.ontologyId,
    };
    const connect = connectOntologyWorker({ connectionTimeoutMs: 20_000 }).pipe(
        Effect.provide(
            BrowserWorker.layer(
                () =>
                    new SharedWorker(new URL("./ontologyOwner.worker.ts", import.meta.url), {
                        name: JSON.stringify(partition),
                        type: "module",
                    })
            )
        )
    );
    const traces = createRuntimeTraces();
    const open = Effect.gen(function* () {
        const runtime = yield* Runtime;
        const source = yield* connect;
        const replica = yield* makeReplica({
            namespace: options.id ?? "tab",
            ir: options.ir,
            tables: runtime.tables,
            source,
            gc: false,
            outbox: options.writes?.outbox,
            execute: (tx, invocation, settings) =>
                executeTransactionMutator({
                    ir: options.ir,
                    tx,
                    name: invocation.name,
                    parameters: invocation.parameters,
                    invocationId: invocation.id,
                    replay: invocation.replay,
                    resolveOnly: settings?.optimistic === false,
                    context: options.context ?? {},
                    mutators: options.writes?.mutators,
                }),
        });
        const helpers = source.operations;
        const view = yield* makeReplicaOntologyView({
            ir: options.ir,
            context: options.context ?? {},
            replica,
            writes: options.writes,
            attachments: helpers.attachments,
            queryFunction: helpers.queryFunction,
            resolveActionParameters: helpers.resolveActionParameters,
            decrypt: helpers.decrypt,
            traces,
            diagnosticLabel: "This tab",
            parentDiagnostics: {
                label: "Host",
                role: "host",
                location: "Shared worker",
                replica: helpers.replicaMonitor,
                traces: helpers.traces,
            },
            parentOutbox: helpers.outbox,
            awaitParentAcceptance: true,
            validate: (name, parameters) => helpers.validate(name, parameters),
            validateDraft: (name, parameters, known) => helpers.validate(name, parameters, known),
        });
        return {
            view,
            deleteLocalData: helpers.deleteLocalData.pipe(
                Effect.tap(() => helpers.releaseOwner.pipe(Effect.catch(() => Effect.void)))
            ),
        };
    });
    class Tab extends Context.Service<Tab, Effect.Success<typeof open>>()("issue-tracker/Tab") {}
    const app = ManagedRuntime.make(
        Layer.effect(Tab, open).pipe(
            Layer.provide(
                WebRuntime.layer({
                    owner: options.userId,
                    namespace: `tab:${crypto.randomUUID()}`,
                    storage: "memory",
                })
            ),
            Layer.provideMerge(Layer.succeed(Tracer.Tracer, traces.tracer))
        )
    );
    try {
        const { view, deleteLocalData } = await app.runPromise(Tab);
        const restored = (event: PageTransitionEvent) => {
            if (event.persisted) window.location.reload();
        };
        const cleanup = (restore = false) => {
            window.removeEventListener("pagehide", hidden);
            if (!restore) window.removeEventListener("pageshow", restored);
            return app.dispose();
        };
        const hidden = () => {
            void cleanup(true).catch(() => undefined);
        };
        window.addEventListener("pagehide", hidden, { once: true });
        window.addEventListener("pageshow", restored);
        return {
            ...view,
            cleanup: () => cleanup(),
            destroy: async () => {
                try {
                    await app.runPromise(deleteLocalData);
                } finally {
                    await cleanup();
                }
            },
        };
    } catch (cause) {
        await app.dispose();
        if (
            !(cause instanceof BackendError) ||
            cause.kind !== "Unavailable" ||
            !["worker.connect", "remote.protocol"].includes(cause.operation)
        )
            throw cause;
        // Web Locks still serialize the persistent owner if worker startup is unavailable.
        console.warn("Shared ontology startup failed; using the in-process owner.", cause);
        return createLiveOntology(options);
    }
}
