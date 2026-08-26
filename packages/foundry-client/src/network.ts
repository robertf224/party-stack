export interface CreateFoundryFetchOptions {
    tokenProvider: () => Promise<string>;
    fetch?: typeof globalThis.fetch;
}

export interface CreateFoundryWebSocketOptions {
    tokenProvider: () => Promise<string>;
    createWebSocket?: (url: string | URL, protocols?: string | string[]) => WebSocket | Promise<WebSocket>;
}

export function createFoundryFetch(options: CreateFoundryFetchOptions): typeof globalThis.fetch {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    return async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${await options.tokenProvider()}`);
        return fetchImpl(new Request(request, { headers }));
    };
}

export function createFoundryWebSocket(
    options: CreateFoundryWebSocketOptions
): (url: string | URL, protocols?: string | string[]) => Promise<WebSocket> {
    const createWebSocket = options.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    return async (url, protocols) => {
        const token = await options.tokenProvider();
        const requested = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
        return createWebSocket(url, [`Bearer-${token}`, ...requested]);
    };
}
