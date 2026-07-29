import { once, race, run, sleep, type Task } from "effection";
import type { NetworkConnectivity } from "@party-stack/runtime";

const ONLINE_STABILIZATION_MS = 1_000;

export class NavigatorNetworkConnectivity implements NetworkConnectivity {
    private readonly listeners = new Set<(isConnected: boolean) => void>();
    private lifetime!: Task<void>;
    private connected: boolean;
    private closePromise: Promise<void> | undefined;

    private constructor(initiallyConnected: boolean) {
        this.connected = initiallyConnected;
    }

    static create(): NavigatorNetworkConnectivity {
        const connectivity = new NavigatorNetworkConnectivity(navigator.onLine);
        connectivity.lifetime = run(function* () {
            while (true) {
                const online = yield* race([
                    (function* () {
                        yield* once(window, "online");
                        return true;
                    })(),
                    (function* () {
                        yield* once(window, "offline");
                        return false;
                    })(),
                ]);
                if (!online) {
                    connectivity.setConnected(false);
                    continue;
                }
                if (connectivity.isConnected) continue;

                const stabilized = yield* race([
                    (function* () {
                        yield* sleep(ONLINE_STABILIZATION_MS);
                        return navigator.onLine;
                    })(),
                    (function* () {
                        yield* once(window, "offline");
                        return false;
                    })(),
                ]);
                connectivity.setConnected(stabilized);
            }
        });
        void connectivity.lifetime.catch(() => undefined);
        return connectivity;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    subscribe(listener: (isConnected: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    close(): Promise<void> {
        this.closePromise ??= Promise.resolve(this.lifetime.halt()).finally(() => {
            this.listeners.clear();
        });
        return this.closePromise;
    }

    private setConnected(isConnected: boolean): void {
        if (isConnected === this.connected) return;
        this.connected = isConnected;
        for (const listener of this.listeners) {
            listener(isConnected);
        }
    }
}
