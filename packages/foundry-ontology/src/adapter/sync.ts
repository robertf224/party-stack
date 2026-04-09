import { useObjectSetWatcherSubscription } from "@party-stack/foundry-object-set-watcher/effection";
import { SyncConfig } from "@tanstack/db";
import { run } from "effection";

export function createSyncConfig(opts: { objectType: string }): SyncConfig {
    return {
        sync: ({ collection }) => {
            // TODO: run on passed-in scope
            const task = run(function* () {
                const messages = yield* useObjectSetWatcherSubscription({ type: "base", objectType });

                // TODO: maybe just peek at latest instead
                const cursor = new Date().toISOString();

                while (true) {
                    const nextMessage = yield* messages.next();
                    if (nextMessage.done) {
                        break;
                    }
                    const message = nextMessage.value;

                    // iterate over history
                }

                // wait for subscription messages, catch up when we see.
                // also if we were offline for any period of time and we get connectivity again,
                // make sure we do a catch-up
                // also push seen tx ids into some channel as we iterate over history
                // -> txid might go thru channel before we get it back to await it from action, so we
                //    will need to make sure we open subscription to tx ids committed in action beforehand.
                //
            });

            return {
                cleanup: () => {
                    void task.halt();
                },
            };
        },
    };
}
