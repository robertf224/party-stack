import type { NetworkConnectivity } from "@party-stack/runtime";

export class ServerNetworkConnectivity implements NetworkConnectivity {
    readonly isConnected = true;

    subscribe(_callback: (isConnected: boolean) => void): () => void {
        void _callback;
        return () => {};
    }
}
