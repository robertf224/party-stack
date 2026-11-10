import { useDbClient } from "@tanstack/react-db";
import { Effect, Layer } from "effect";
import { Component, StrictMode, Suspense, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BackendError } from "../../ontology-backend/lib/index.js";
import { MemoryRuntime, Runtimes } from "../../runtime/lib/index.js";
import { AuthenticationProvider, useAuthentication } from "../src/authentication.js";
import { OntologyProvider, OntologyEnvironmentProvider, useOntology } from "../src/index.js";
import type { CreateLiveOntologyOpts, OntologyClient, OntologyServerClient } from "@party-stack/ontology";

const commands: string[] = [];
const requests: { userId: string; closed: number; release: () => void }[] = [];
type AwaitedBackend = NonNullable<OntologyClient["backend"]>;
const params = new URL(location.href).searchParams;
const construction = params.has("construction");
const setups = Object.fromEntries(
    ["alice", "bob", "carol"].map((userId) => [
        userId,
        {
            ir: { types: [], objectTypes: [], linkTypes: [], actionTypes: [], queryFunctionTypes: [] },
            context: { user: userId },
            backend: Effect.gen(function* () {
                let request: (typeof requests)[number];
                return yield* Effect.acquireRelease(
                    Effect.promise(
                        () =>
                            new Promise<AwaitedBackend>((resolve) => {
                                request = {
                                    userId,
                                    closed: 0,
                                    release: () =>
                                        resolve({
                                            name: "provider-fixture",
                                            sourceId: userId,
                                            supportsIdempotency: true,
                                            loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                                            query: () => Effect.succeed({}),
                                            queryFunction: () => Effect.succeed(undefined),
                                            applyAction: (action: { id: string; name: string }) =>
                                                Effect.sync(() => {
                                                    commands.push(action.name);
                                                    return {
                                                        operationId: action.id,
                                                        outcome: "committed" as const,
                                                        affected: [],
                                                    };
                                                }),
                                        }),
                                };
                                requests.push(request);
                            })
                    ),
                    () =>
                        Effect.sync(() => {
                            request.closed++;
                        })
                );
            }),
        } satisfies CreateLiveOntologyOpts,
    ])
);

const clients: OntologyServerClient = {
    ontology: (ontology = "alice") =>
        Effect.gen(function* () {
            const setup = setups[ontology === "connect" ? "alice" : ontology]!;
            const backend = yield* setup.backend;
            return {
                ir: setup.ir,
                context: setup.context,
                sourceId: ontology,
                backend,
                replication: { kind: "committed" as const },
                operations: {},
            } as unknown as OntologyClient;
        }),
};

function Consumer() {
    const ontology = useOntology();
    const client = useDbClient();
    if (client !== ontology.dbClient) throw new Error("Provider supplied a different query client.");
    return (
        <>
            <span data-testid="account">{String(ontology.context.user)}</span>
            <span data-testid="label">{ontology.diagnostics?.label}</span>
        </>
    );
}
function App() {
    const [userId, select] = useState("alice");
    const [visible, setVisible] = useState(true);
    const [renderCount, rerender] = useState(0);
    return (
        <>
            {["alice", "bob", "carol"].map((account) => (
                <button key={account} onClick={() => select(account)}>
                    {account}
                </button>
            ))}
            <button onClick={() => setVisible(false)}>Unmount</button>
            <button onClick={() => rerender((count) => count + 1)}>Rerender</button>
            <span data-testid="render-count">{renderCount}</span>
            {visible && (
                <Suspense fallback={<span data-testid="pending">Opening</span>}>
                    <OntologyProvider
                        {...(construction ? setups[userId]! : { ontology: userId })}
                        label={construction ? "Local" : undefined}
                    >
                        <Consumer />
                    </OntologyProvider>
                </Suspense>
            )}
        </>
    );
}
function AuthenticationConsumer() {
    const authentication = useAuthentication();
    const [done, setDone] = useState(false);
    return (
        <button
            onClick={() =>
                void authentication
                    .signOut({ kind: "external-session", id: "saved" })
                    .then(() => setDone(true))
            }
        >
            {done ? "Disconnected" : "Disconnect"}
        </button>
    );
}
const transport = { opened: 0, closed: 0 };
const startup = { childOpens: 0, resolved: 0 };
let releaseTransport!: () => void;
const transportReady = new Promise<void>((resolve) => {
    releaseTransport = resolve;
});
const ownedTransport = (client: OntologyServerClient, held = false) =>
    Effect.acquireRelease(
        Effect.sync(() => {
            transport.opened++;
            return client;
        }),
        () =>
            Effect.sync(() => {
                transport.closed++;
            })
    ).pipe(
        Effect.tap(() =>
            Effect.gen(function* () {
                if (held) yield* Effect.promise(() => transportReady);
                if (held && params.has("fail"))
                    return yield* new BackendError({
                        operation: "fixture.transport",
                        kind: "Unavailable",
                        retryable: false,
                        message: "Fixture transport failed",
                    });
                startup.resolved++;
            })
        )
    );
const shared = params.has("owned") ? ownedTransport(clients, params.has("held")) : clients;
const replacement = ownedTransport({ ontology: () => clients.ontology("bob") });
const openingRuntime = Runtimes.layer(MemoryRuntime.layer).pipe(
    Layer.tap(() =>
        Effect.sync(() => {
            startup.childOpens++;
        })
    )
);
let replaceTransport!: () => void;
class StartupBoundary extends Component<{ children: ReactNode }, { error?: string; kind?: string }> {
    state: { error?: string; kind?: string } = {};
    static getDerivedStateFromError(error: Error) {
        return { error: error.message, kind: error instanceof BackendError ? error.kind : undefined };
    }
    render() {
        return this.state.error ? (
            <output data-testid="error" data-error-kind={this.state.kind}>
                {this.state.error}
            </output>
        ) : (
            this.props.children
        );
    }
}
function EnvironmentApp() {
    const [client, setClient] = useState(shared);
    useEffect(() => {
        replaceTransport = () => setClient(() => replacement);
        return () => {
            replaceTransport = () => undefined;
        };
    }, []);
    return (
        <StartupBoundary>
            <OntologyEnvironmentProvider
                client={client}
                label="Environment"
                runtime={params.has("held") ? openingRuntime : undefined}
            >
                {params.has("connect") ? (
                    <Suspense fallback={<span>Opening Connect</span>}>
                        <AuthenticationProvider label="Accounts">
                            <AuthenticationConsumer />
                        </AuthenticationProvider>
                    </Suspense>
                ) : params.has("unused") ? (
                    <span data-testid="unused">Unused transport</span>
                ) : (
                    <App />
                )}
            </OntologyEnvironmentProvider>
        </StartupBoundary>
    );
}
const root = createRoot(document.getElementById("root")!, { onCaughtError: () => {} });
const app = <EnvironmentApp />;
root.render(params.has("strict") ? <StrictMode>{app}</StrictMode> : app);
Reflect.set(window, "fixture", {
    transport: () => transport,
    startup: () => startup,
    commands: () => commands,
    close: () => root.unmount(),
    replaceTransport: () => replaceTransport(),
    releaseTransport: () => releaseTransport(),
    requests: () => requests.map(({ userId, closed }) => ({ userId, closed })),
    release: (index: number) => requests[index]!.release(),
});
