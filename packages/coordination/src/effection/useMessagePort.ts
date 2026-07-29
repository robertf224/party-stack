import {
    createSignal,
    race,
    resource,
    withResolvers,
    type Operation,
    type Stream,
} from "effection";
import type {
    CoordinationMessagePort,
    CoordinationPortEvent,
} from "../shared-worker/contracts.js";

export interface MessagePortResource
    extends Stream<
        CoordinationPortEvent,
        CoordinationPortEvent
    > {
    readonly port: CoordinationMessagePort;
}

export interface UseMessagePortOptions {
    readonly closeOnDispose?: boolean;
}

export function useMessagePort(
    port: CoordinationMessagePort,
    options: UseMessagePortOptions = {}
): Operation<MessagePortResource> {
    return resource(function* (provide) {
        const messages = createSignal<
            CoordinationPortEvent,
            CoordinationPortEvent
        >();
        const closed =
            withResolvers<CoordinationPortEvent>(
                "message port closed"
            );
        let isClosed = false;
        const close = (
            event: CoordinationPortEvent = {}
        ) => {
            if (isClosed) return;
            isClosed = true;
            messages.close(event);
            closed.resolve(event);
        };
        const onMessage = (
            event: CoordinationPortEvent
        ) => messages.send(event);
        port.addEventListener(
            "message",
            onMessage
        );
        port.addEventListener(
            "messageerror",
            close
        );
        port.addEventListener("close", close);
        port.start?.();
        const resourceHandle: MessagePortResource =
            {
                port,
                [Symbol.iterator]:
                    messages[Symbol.iterator],
            };
        try {
            yield* race([
                closed.operation,
                provide(resourceHandle),
            ]);
        } finally {
            port.removeEventListener(
                "message",
                onMessage
            );
            port.removeEventListener(
                "messageerror",
                close
            );
            port.removeEventListener("close", close);
            if (options.closeOnDispose ?? true) {
                port.close?.();
            }
            close();
        }
    });
}
