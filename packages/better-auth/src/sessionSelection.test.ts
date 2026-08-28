import { describe, expect, it } from "vitest";
import {
    createPartyStackSessionProtocol,
    getPartyStackSessionId,
    PARTY_STACK_SESSION_HEADER,
    withoutPartyStackSessionProtocols,
} from "./sessionSelection.js";

describe("session selection", () => {
    it("selects HTTP sessions from the Party Stack header", () => {
        const headers = new Headers({
            [PARTY_STACK_SESSION_HEADER]:
                "session-1",
        });

        expect(
            getPartyStackSessionId(headers)
        ).toBe("session-1");
    });

    it("selects WebSocket sessions from offered protocols", () => {
        const protocol =
            createPartyStackSessionProtocol(
                "session-1"
            );
        const headers = new Headers({
            "sec-websocket-protocol": [
                protocol,
                "ontology",
            ].join(", "),
        });

        expect(
            getPartyStackSessionId(headers)
        ).toBe("session-1");
        expect(
            withoutPartyStackSessionProtocols([
                protocol,
                "ontology",
            ])
        ).toEqual(["ontology"]);
    });

    it("rejects session IDs that are not protocol tokens", () => {
        expect(() =>
            createPartyStackSessionProtocol(
                "invalid session"
            )
        ).toThrow(
            "Better Auth session ID cannot be encoded as a WebSocket protocol."
        );
    });
});
