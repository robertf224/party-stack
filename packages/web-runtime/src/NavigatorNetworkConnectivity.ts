import { Effect, Exit, Fiber, Scope } from "effect";
import type { NetworkConnectivity } from "@party-stack/runtime";

const ONLINE_STABILIZATION_MS = 1_000;

export class NavigatorNetworkConnectivity implements NetworkConnectivity {
    private readonly listeners = new Set<(isConnected: boolean) => void>();
    private readonly lifetime = Scope.makeUnsafe();
    private stabilization: Fiber.Fiber<void> | undefined;
    private connected: boolean;
    private closed = false;
    private closePromise: Promise<void> | undefined;

    private constructor(initiallyConnected: boolean) {
        this.connected = initiallyConnected;
    }

    static create(): NavigatorNetworkConnectivity {
        const connectivity = new NavigatorNetworkConnectivity(navigator.onLine !== false);
        const target = typeof window === "undefined" ? globalThis : window;
        const changed = () => {
            if (connectivity.closed) return;
            const previous = connectivity.stabilization;
            if (!navigator.onLine) connectivity.setConnected(false);
            connectivity.stabilization = Effect.runSync(
                Effect.forkIn(
                    Effect.gen(function* () {
                        if (previous) yield* Fiber.interrupt(previous);
                        if (!navigator.onLine || connectivity.connected) return;
                        yield* Effect.sleep(ONLINE_STABILIZATION_MS);
                        if (!connectivity.closed) connectivity.setConnected(navigator.onLine);
                    }),
                    connectivity.lifetime,
                    { startImmediately: true }
                )
            );
        };
        target.addEventListener("online", changed);
        target.addEventListener("offline", changed);
        Effect.runSync(
            Scope.addFinalizer(
                connectivity.lifetime,
                Effect.sync(() => {
                    target.removeEventListener("online", changed);
                    target.removeEventListener("offline", changed);
                    connectivity.listeners.clear();
                })
            )
        );
        return connectivity;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    subscribe(listener: (isConnected: boolean) => void): () => void {
        if (this.closed) return () => {};
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    close(): Promise<void> {
        this.closed = true;
        this.closePromise ??= Effect.runPromise(Scope.close(this.lifetime, Exit.void));
        return this.closePromise;
    }

    private setConnected(isConnected: boolean): void {
        if (isConnected === this.connected) return;
        this.connected = isConnected;
        for (const listener of this.listeners) listener(isConnected);
    }
}
