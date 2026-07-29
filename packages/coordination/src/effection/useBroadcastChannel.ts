import {
    on,
    once,
    race,
    resource,
    type Operation,
    type Stream,
} from "effection";
import {
    CoordinationTransportError,
} from "../contracts.js";

export interface BroadcastChannelResource<Message>
    extends Stream<MessageEvent<Message>, void> {
    readonly name: string;
    postMessage(message: Message): void;
}

export function useBroadcastChannel<Message>(
    name: string
): Operation<BroadcastChannelResource<Message>> {
    return resource(function* (provide) {
        const channel = new BroadcastChannel(name);
        const messages = on(
            channel,
            "message"
        ) as Stream<MessageEvent<Message>, void>;
        const handle: BroadcastChannelResource<Message> =
            {
                get name() {
                    return channel.name;
                },
                postMessage: (message) =>
                    channel.postMessage(message),
                [Symbol.iterator]:
                    messages[Symbol.iterator],
            };
        try {
            yield* race([
                (function* () {
                    yield* once(
                        channel,
                        "messageerror"
                    );
                    throw new CoordinationTransportError(
                        `Broadcast channel "${name}" received an unreadable message.`,
                        "TRANSPORT_ERROR"
                    );
                })(),
                provide(handle),
            ]);
        } finally {
            channel.close();
        }
    });
}
