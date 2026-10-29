import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { connectInstallationWorker } from "@party-stack/ontology-server/installation/worker";
import { queryOnce } from "@tanstack/db";
import { Effect, Exit, Scope } from "effect";
import * as WebRuntime from "../src/WebRuntime.js";

// Fail the test if a page opens private persistent storage. Only the SharedWorker may do so.
indexedDB.open = () => {
    throw new Error("A page attempted to open persistent tables.");
};
const namespace = new URL(location.href).searchParams.get("scope")!;
const scope = Effect.runSync(Scope.make());
const installation = await Effect.runPromise(
    Scope.provide(
        connectInstallationWorker<{ signIn(userId: string): Promise<void> }>({
            runtime: WebRuntime.layer({ storage: "memory" }),
        }).pipe(
            Effect.provide(
                BrowserWorker.layer(
                    () =>
                        new SharedWorker(new URL("./installation-owner.worker.ts", import.meta.url), {
                            name: namespace,
                            type: "module",
                        })
                )
            )
        ),
        scope
    )
).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.fail(error)));
    Reflect.set(window, "installationFailure", error);
    return undefined;
});
const traceSubscriptions: (() => void)[] = [];
if (installation)
    Reflect.set(window, "installationTest", {
        signIn: (userId: string) => installation.authentication.signIn(userId),
        connections: () => [...installation.connections.values()],
        rows: async (ontologyId: string) => {
            const live = await installation.openOntology({ userId: "alice", ontologyId });
            return await queryOnce((q) => q.from({ counter: live.objects.Counter! }));
        },
        increment: async (ontologyId: string) => {
            const live = await installation.openOntology({ userId: "alice", ontologyId });
            await live.actions.increment!({});
        },
        startTracing: async (ontologyId: string) => {
            const live = await installation.openOntology({ userId: "alice", ontologyId });
            if (!live.traces || !live.diagnostics?.parent?.traces)
                throw new Error("Missing default worker diagnostics.");
            const traces = live.diagnostics.parent.traces;
            await new Promise<void>((resolve) => {
                traceSubscriptions.push(traces.subscribe(() => resolve()));
            });
        },
        traces: async (ontologyId: string) => {
            const live = await installation.openOntology({ userId: "alice", ontologyId });
            return live.diagnostics?.parent?.traces?.getSnapshot();
        },
        clearTraces: async (ontologyId: string) => {
            const live = await installation.openOntology({ userId: "alice", ontologyId });
            live.diagnostics?.parent?.traces?.clear();
            return live.diagnostics?.parent?.traces?.getSnapshot();
        },
        rejectedPrototypeCall: async () => {
            try {
                await (
                    installation.authentication as unknown as { constructor(): Promise<unknown> }
                ).constructor();
                return "allowed";
            } catch (error) {
                return (error as { kind: string }).kind;
            }
        },
        disconnect: () => installation.disconnect("alice"),
        cleanup: () => {
            for (const unsubscribe of traceSubscriptions) unsubscribe();
            return Effect.runPromise(Scope.close(scope, Exit.void));
        },
    });
