export const PARTY_STACK_SESSION_HEADER =
    "x-party-stack-connection-session";
export const PARTY_STACK_SESSION_PROTOCOL_PREFIX =
    "party-stack.session.";

const protocolToken =
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function createPartyStackSessionProtocol(
    sessionId: string
): string {
    if (!protocolToken.test(sessionId)) {
        throw new Error(
            "Better Auth session ID cannot be encoded as a WebSocket protocol."
        );
    }
    return `${PARTY_STACK_SESSION_PROTOCOL_PREFIX}${sessionId}`;
}

export function getPartyStackSessionId(
    headers: Headers
): string | undefined {
    const header = headers.get(
        PARTY_STACK_SESSION_HEADER
    );
    if (header) return header;
    const protocols = headers.get(
        "sec-websocket-protocol"
    );
    return protocols
        ?.split(",")
        .map((protocol) => protocol.trim())
        .find((protocol) =>
            protocol.startsWith(
                PARTY_STACK_SESSION_PROTOCOL_PREFIX
            )
        )
        ?.slice(
            PARTY_STACK_SESSION_PROTOCOL_PREFIX.length
        );
}

export function withoutPartyStackSessionProtocols(
    protocols: Iterable<string>
): string[] {
    return Array.from(protocols).filter(
        (protocol) =>
            !protocol.startsWith(
                PARTY_STACK_SESSION_PROTOCOL_PREFIX
            )
    );
}
