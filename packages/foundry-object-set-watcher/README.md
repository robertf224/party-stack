# @party-stack/foundry-object-set-watcher

An Effect service for Foundry object-set websocket subscriptions.

```ts
import { makeObjectSetWatcher } from "@party-stack/foundry-object-set-watcher";
import { Effect, Stream } from "effect";

const program = Effect.scoped(
    Effect.gen(function* () {
        const watcher = yield* makeObjectSetWatcher(client);
        yield* Stream.runForEach(watcher.subscribe({ type: "base", objectType: "Issue" }), (message) =>
            Effect.log(message.type)
        );
    })
);
```

Subscriptions share a socket. Scopes own subscription leases, reconnects,
heartbeats, acknowledgments, and cancellation. Closing the last consumer releases
its socket. Bounded queues fail explicitly rather than dropping object updates.

The manager shares logical consumers by object-set definition. The session retains
desired subscriptions across reconnects; the connection owns one physical socket,
request acknowledgments, heartbeat and frame decoding. A late logical consumer sees
the current connection state without forcing a new physical subscription.

The Foundry ontology adapter uses supported subset predicates to filter watched
object sets. Unsupported predicates broaden the watch, and exact query evaluation
still happens locally. Watch messages are invalidation hints: a removed object may
have left a filter rather than been deleted. Reconnection requires a refresh.

The main export retains the callback manager facade for application integration;
its resources delegate to the same Effect service. Effection exports have been removed.

# Callback consumers

The main export exposes the Effect service and scoped constructor. Callback-based
consumers can explicitly import the facade:

```ts
import { ObjectSetWatcherManager } from "@party-stack/foundry-object-set-watcher/callback";
```

The facade uses the same Effect implementation internally. Party Stack's native
Foundry backend uses the scoped service directly.
