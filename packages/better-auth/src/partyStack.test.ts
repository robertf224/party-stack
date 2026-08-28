import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { partyStack } from "./partyStack.js";
import {
    createPartyStackSessionProtocol,
    PARTY_STACK_SESSION_HEADER,
} from "./sessionSelection.js";

describe("partyStack", () => {
    it("provides the multi-session server API", () => {
        const plugin = partyStack({
            maximumSessions: 10,
        });

        expect(plugin.id).toBe("party-stack");
        expect(
            plugin.endpoints
                .listDeviceSessions
        ).toBeDefined();
        expect(
            plugin.endpoints.setActiveSession
        ).toBeDefined();
        expect(
            plugin.endpoints
                .revokeDeviceSession
        ).toBeDefined();
    });

    it("makes normal getSession calls request-scoped", async () => {
        const database = {
            user: [],
            session: [],
            account: [],
            verification: [],
        };
        const auth = betterAuth({
            baseURL: "http://localhost:3000",
            secret: "party-stack-test-secret-party-stack-test-secret",
            database:
                memoryAdapter(database),
            emailAndPassword: {
                enabled: true,
                minPasswordLength: 3,
            },
            session: {
                cookieCache: {
                    enabled: true,
                    maxAge: 300,
                },
            },
            plugins: [partyStack()],
        });
        const cookies = new Map<
            string,
            string
        >();
        const cookieHeader = () =>
            Array.from(
                cookies,
                ([name, value]) =>
                    `${name}=${value}`
            ).join("; ");
        const applyCookies = (
            response: Response
        ) => {
            for (const value of response.headers.getSetCookie()) {
                const [pair] =
                    value.split(";");
                const separator =
                    pair!.indexOf("=");
                const name = pair!.slice(
                    0,
                    separator
                );
                const cookieValue =
                    pair!.slice(
                        separator + 1
                    );
                if (
                    /max-age=0/i.test(
                        value
                    )
                ) {
                    cookies.delete(name);
                } else {
                    cookies.set(
                        name,
                        cookieValue
                    );
                }
            }
        };
        const signUp = async (
            email: string,
            name: string
        ) => {
            const response =
                await auth.handler(
                    new Request(
                        "http://localhost:3000/api/auth/sign-up/email",
                        {
                            method: "POST",
                            headers: {
                                "content-type":
                                    "application/json",
                                cookie: cookieHeader(),
                            },
                            body: JSON.stringify(
                                {
                                    email,
                                    password:
                                        "password",
                                    name,
                                }
                            ),
                        }
                    )
                );
            expect(response.status).toBe(
                200
            );
            applyCookies(response);
        };

        await signUp(
            "ada@example.com",
            "Ada"
        );
        await signUp(
            "grace@example.com",
            "Grace"
        );
        const headers = new Headers({
            cookie: cookieHeader(),
        });
        const sessions =
            await auth.api.listDeviceSessions({
                headers,
            });
        const ada = sessions.find(
            ({ user }) =>
                user.email ===
                "ada@example.com"
        );
        expect(ada).toBeDefined();
        expect(
            (
                await auth.api.getSession({
                    headers,
                })
            )?.user.email
        ).toBe("grace@example.com");

        headers.set(
            PARTY_STACK_SESSION_HEADER,
            ada!.session.id
        );
        expect(
            (
                await auth.api.getSession({
                    headers,
                })
            )?.user.email
        ).toBe("ada@example.com");

        headers.delete(
            PARTY_STACK_SESSION_HEADER
        );
        headers.set(
            "sec-websocket-protocol",
            [
                createPartyStackSessionProtocol(
                    ada!.session.id
                ),
                "ontology",
            ].join(", ")
        );
        expect(
            (
                await auth.api.getSession({
                    headers,
                })
            )?.user.email
        ).toBe("ada@example.com");

        headers.set(
            "sec-websocket-protocol",
            createPartyStackSessionProtocol(
                "missing-session"
            )
        );
        expect(
            await auth.api.getSession({
                headers,
            })
        ).toBeNull();
    });
});
