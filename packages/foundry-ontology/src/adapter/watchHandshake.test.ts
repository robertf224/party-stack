import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeFoundryBackend } from "./backend.js";
import type { OntologyClient } from "@party-stack/foundry-client";

type Request = { id: string; requests: { objectSet: { objectType: string } }[] };
class Socket extends EventTarget {
    readyState = 1;
    constructor(readonly sent: Queue.Queue<Request>) {
        super();
    }
    send(text: string) {
        Queue.offerUnsafe(this.sent, JSON.parse(text) as Request);
    }
    message(data: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
    acknowledge(request: Request, status: "success" | "qos" | "error" = "success") {
        this.message({
            type: "subscribeResponses",
            id: request.id,
            responses: request.requests.map(({ objectSet }) =>
                status === "success"
                    ? { type: status, id: `remote-${objectSet.objectType}` }
                    : { type: status }
            ),
        });
    }
    disconnect() {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
    }
    close = vi.fn(() => this.disconnect());
}
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Issue", "Project"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: name,
        primaryKey: "id",
        properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
    })),
};
const open = (socket: Socket) =>
    makeFoundryBackend({
        client: {
            baseUrl: "https://foundry.example",
            ontologyRid: "ontology",
            fetch: globalThis.fetch,
            createWebSocket: async () => socket as unknown as WebSocket,
        } as unknown as OntologyClient,
        ir,
        context: {},
        decodeObject: (_type, value) => value,
        submitAction: () => {
            throw new Error("Unexpected action");
        },
    });

test("Foundry acquisition waits for its own object-set ACK and buffers before consumption", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const sent = yield* Queue.unbounded<Request>();
                const socket = new Socket(sent);
                const backend = yield* open(socket);
                let issueReady = false;
                let projectReady = false;
                const issue = yield* Effect.forkScoped(
                    backend.watchSubset!(objectSubset("Issue"))!.pipe(
                        Effect.tap(() =>
                            Effect.sync(() => {
                                issueReady = true;
                            })
                        )
                    ),
                    { startImmediately: true }
                );
                const first = yield* Queue.take(sent);
                // The socket is already open and has sent the registration; neither is an ACK.
                expect(issueReady).toBe(false);
                const project = yield* Effect.forkScoped(
                    backend.watchSubset!(objectSubset("Project"))!.pipe(
                        Effect.tap(() =>
                            Effect.sync(() => {
                                projectReady = true;
                            })
                        )
                    ),
                    { startImmediately: true }
                );
                socket.acknowledge(first);
                yield* Fiber.join(issue);
                const second = yield* Queue.take(sent);
                expect(second.requests.map((entry) => entry.objectSet.objectType)).toEqual([
                    "Issue",
                    "Project",
                ]);
                expect(projectReady).toBe(false);
                socket.acknowledge(second);
                const changes = yield* Fiber.join(project);
                expect(projectReady).toBe(true);
                socket.message({ type: "objectSetChanged", id: "remote-Project", updates: [] });
                // No returned-stream consumer existed when the real socket event arrived.
                expect(yield* Stream.runHead(changes)).toMatchObject({ _tag: "Some", value: undefined });
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});

test.each(["qos", "error"] as const)(
    "Foundry %s before ACK fails acquisition and releases the physical subscription",
    async (status) => {
        let socket: Socket | undefined;
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const sent = yield* Queue.unbounded<Request>();
                    socket = new Socket(sent);
                    const backend = yield* open(socket);
                    const watch = yield* Effect.forkScoped(backend.watchSubset!(objectSubset("Issue"))!, {
                        startImmediately: true,
                    });
                    socket.acknowledge(yield* Queue.take(sent), status);
                    const result = yield* Effect.result(Fiber.join(watch));
                    // QoS backs off for minutes; a rejected object set is terminal.
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure:
                            status === "qos"
                                ? { kind: "RateLimited", retryable: true, retryAfterMs: 120_000 }
                                : { kind: "InvalidRequest", retryable: false },
                    });
                })
            ).pipe(Effect.timeout("2 seconds"))
        );
        expect(socket?.close).toHaveBeenCalled();
    }
);

test("Foundry connection loss fails an acquired watch instead of silently retaining coverage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const sent = yield* Queue.unbounded<Request>();
                const socket = new Socket(sent);
                const backend = yield* open(socket);
                const acquired = yield* Effect.forkScoped(backend.watchSubset!(objectSubset("Issue"))!, {
                    startImmediately: true,
                });
                socket.acknowledge(yield* Queue.take(sent));
                const watch = yield* Fiber.join(acquired);
                socket.disconnect();
                const result = yield* Effect.result(Stream.runDrain(watch));
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Unavailable", retryable: true },
                });
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});

test("closing the acquisition scope cancels an unacknowledged Foundry registration", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const sent = yield* Queue.unbounded<Request>();
                const socket = new Socket(sent);
                const backend = yield* open(socket);
                const scope = yield* Scope.fork(yield* Effect.scope);
                yield* Effect.forkIn(
                    Scope.provide(backend.watchSubset!(objectSubset("Issue"))!, scope),
                    scope,
                    {
                        startImmediately: true,
                    }
                );
                yield* Queue.take(sent);
                yield* Scope.close(scope, Exit.void);
                expect(socket.close).toHaveBeenCalledOnce();
            })
        ).pipe(Effect.timeout("2 seconds"))
    );
});
