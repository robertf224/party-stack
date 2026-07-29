import NetInfo from "@react-native-community/netinfo";
import type { NetworkConnectivity } from "@party-stack/runtime";

export class ExpoNetworkConnectivity
    implements NetworkConnectivity
{
    private readonly listeners = new Set<
        (isConnected: boolean) => void
    >();
    private connected: boolean;
    private readonly unsubscribe: () => void;

    static async create(): Promise<ExpoNetworkConnectivity> {
        const initialState = await NetInfo.fetch();
        return new ExpoNetworkConnectivity(
            initialState.isConnected === true
        );
    }

    private constructor(initialIsConnected: boolean) {
        this.connected = initialIsConnected;
        this.unsubscribe = NetInfo.addEventListener((state) => {
            this.update(state.isConnected === true);
        });
    }

    get isConnected(): boolean {
        return this.connected;
    }

    subscribe(
        listener: (isConnected: boolean) => void
    ): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    close(): void {
        this.unsubscribe();
        this.listeners.clear();
    }

    private update(isConnected: boolean): void {
        if (isConnected === this.connected) return;
        this.connected = isConnected;
        for (const listener of this.listeners) {
            listener(isConnected);
        }
    }
}
