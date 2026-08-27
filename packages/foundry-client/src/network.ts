export interface CreateFoundryFetchOptions {
    baseUrl: string;
    tokenProvider: () => Promise<string>;
    fetch?: typeof globalThis.fetch;
}

export interface CreateFoundryWebSocketOptions {
    baseUrl: string;
    tokenProvider: () => Promise<string>;
    createWebSocket?: (url: string | URL, protocols?: string | string[]) => WebSocket | Promise<WebSocket>;
}

function normalizeEgressOrigin(value: string | URL): string {
    const url = new URL(value);
    if (url.protocol === "ws:") {
        url.protocol = "http:";
    } else if (url.protocol === "wss:") {
        url.protocol = "https:";
    }
    return url.origin;
}

function assertEgressOrigin(value: string | URL, baseUrl: string): void {
    const actual = normalizeEgressOrigin(value);
    const expected = normalizeEgressOrigin(baseUrl);
    if (actual !== expected) {
        throw new Error(`Egress not allowed for origin "${actual}".`);
    }
}

export function createFoundryFetch(options: CreateFoundryFetchOptions): typeof globalThis.fetch {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    return async (input, init) => {
        const request = new Request(input, init);
        assertEgressOrigin(request.url, options.baseUrl);
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
        assertEgressOrigin(url, options.baseUrl);
        const token = await options.tokenProvider();
        const requested = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
        return createWebSocket(url, [`Bearer-${token}`, ...requested]);
    };
}
