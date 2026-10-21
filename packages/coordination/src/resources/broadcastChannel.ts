import { Effect, Queue, Stream } from "effect";
import { CoordinationTransportError } from "../contracts.js";
import { normalizeError } from "../internal.js";

export interface BroadcastChannelResource<Message> {
    readonly name: string;
    readonly messages: Stream.Stream<MessageEvent<Message>, CoordinationTransportError>;
    postMessage(message: Message): void;
}

export const broadcastChannel = Effect.fnUntraced(function* <Message>(name: string) {
    const channel = yield* Effect.acquireRelease(
        Effect.try({ try: () => new BroadcastChannel(name), catch: normalizeError }),
        (channel) => Effect.sync(() => channel.close())
    );
    const queue = yield* Queue.make<MessageEvent<Message>, CoordinationTransportError>();
    yield* Effect.acquireRelease(
        Effect.sync(() => {
            const message = (event: MessageEvent<Message>) => {
                Queue.offerUnsafe(queue, event);
            };
            const error = () => {
                Effect.runSync(
                    Queue.fail(
                        queue,
                        new CoordinationTransportError(
                            `Broadcast channel "${name}" received an unreadable message.`,
                            "TRANSPORT_ERROR"
                        )
                    )
                );
            };
            channel.addEventListener("message", message);
            channel.addEventListener("messageerror", error);
            return { message, error };
        }),
        ({ message, error }) =>
            Effect.sync(() => {
                channel.removeEventListener("message", message);
                channel.removeEventListener("messageerror", error);
                Queue.shutdownUnsafe(queue);
            })
    );
    return {
        name: channel.name,
        messages: Stream.fromQueue(queue),
        postMessage: (message: Message) => channel.postMessage(message),
    } satisfies BroadcastChannelResource<Message>;
});
