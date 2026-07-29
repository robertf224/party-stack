import { expectTypeOf, it } from "vitest";
import {
    SharedWorkerCoordinationClient,
    SharedWorkerCoordinationHost,
} from "./shared-worker/index.js";
import {
    SingleProcessCoordination,
    type CoordinationServiceClient,
    type CoordinationTaskContext,
} from "./index.js";

type TypedService = {
    methods: {
        add(input: {
            left: number;
            right: number;
        }): Promise<number>;
        label(input: { id: string }): Promise<string>;
    };
    events: {
        changed: { id: string; revision: number };
        reset: undefined;
    };
};

function acceptsPlatformWorkerTypes(
    worker: SharedWorker,
    port: MessagePort
): void {
    const client = new SharedWorkerCoordinationClient({
        scope: "typed-worker",
        worker,
    });
    const fromPort = new SharedWorkerCoordinationClient({
        scope: "typed-worker",
        worker: port,
    });
    const fromFactory = new SharedWorkerCoordinationClient({
        scope: "typed-worker",
        worker: () => worker,
    });
    const host = new SharedWorkerCoordinationHost({
        scope: "typed-worker",
    });
    host.connect(port);
    void client;
    void fromPort;
    void fromFactory;
}
void acceptsPlatformWorkerTypes;

it("maps service method, handler, and event types", async () => {
    const coordination = new SingleProcessCoordination({
        scope: "types",
    });
    const client =
        coordination.service<TypedService>("typed.v1");
    expectTypeOf(client).toMatchTypeOf<
        CoordinationServiceClient<TypedService>
    >();
    expectTypeOf(client.methods.add)
        .parameter(0)
        .toEqualTypeOf<{
            left: number;
            right: number;
        }>();
    expectTypeOf(client.methods.add)
        .returns.toEqualTypeOf<Promise<number>>();

    const server = coordination.serve<TypedService>(
        "typed.v1",
        {
            add: (input, context) => {
                expectTypeOf(input).toEqualTypeOf<{
                    left: number;
                    right: number;
                }>();
                expectTypeOf(
                    context
                ).toEqualTypeOf<CoordinationTaskContext>();
                return input.left + input.right;
            },
            label: ({ id }) => id,
        }
    );
    client.events.subscribe("changed", (event) => {
        expectTypeOf(event).toEqualTypeOf<{
            id: string;
            revision: number;
        }>();
    });
    server.events.publish("changed", {
        id: "one",
        revision: 1,
    });

    const assertInvalidCalls = async () => {
        // @ts-expect-error Unknown methods are rejected.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await client.methods.remove({ id: "one" });
        // @ts-expect-error Method input is inferred.
        await client.methods.add({ left: 1 });
        // @ts-expect-error Unknown events are rejected.
        client.events.subscribe("removed", () => undefined);
        // @ts-expect-error Event payload is inferred.
        server.events.publish("changed", { id: "one" });
        // @ts-expect-error Every service method needs a handler.
        coordination.serve<TypedService>("incomplete.v1", {
            add: ({ left, right }) => left + right,
        });
    };
    void assertInvalidCalls;

    await server.close();
    await coordination.close();
});
