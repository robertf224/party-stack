import { BackendError, EncryptedValueSchema } from "@party-stack/ontology-backend";
import { backendQueryReader } from "@party-stack/ontology-backend/query";
import { TemporalTimestamp } from "@party-stack/ontology-spec/effect";
import { eq, field } from "@party-stack/ontology-storage";
import { Clock, Effect, Schema } from "effect";
import { connectOntology } from "../spec/index.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

const State = Schema.Struct({
    status: Schema.Literals(["active", "needs-auth", "inactive"]),
    accessToken: Schema.optional(EncryptedValueSchema),
    accessTokenExpiresAt: Schema.optional(TemporalTimestamp),
});

/** Egress convenience over ordinary reads, refresh action and property decryption.
 * The supplied backend may be local or remote and must authorize token-property
 * access. This adds no alternate permission path or credential-returning RPC.
 */
export const connectionAccessToken = Effect.fn("Connect.accessToken")(function* (
    backend: OntologyBackendService,
    connectionId: string
) {
    if (!backend.encrypted)
        return yield* new BackendError({
            operation: "decrypt",
            kind: "NotImplemented",
            retryable: false,
            message: "Connection property decryption is unavailable.",
        });
    const read = Effect.fnUntraced(function* () {
        const rows = yield* backendQueryReader(connectOntology, backend).loadSubset("OAuthConnection", {
            where: eq(field("id"), connectionId),
        });
        const row = rows.find((row) => row.key === connectionId);
        if (!row)
            return yield* new BackendError({
                operation: "connect.read",
                kind: "NotFound",
                retryable: false,
                message: "Connection is unavailable.",
            });
        return yield* Schema.decodeUnknownEffect(State)(row.value).pipe(
            Effect.mapError(
                () =>
                    new BackendError({
                        operation: "connect.read",
                        kind: "InvalidResponse",
                        retryable: false,
                        message: "Connection state is invalid.",
                    })
            )
        );
    });
    let current = yield* read();
    const now = yield* Clock.currentTimeMillis;
    // An expired refresh token does not invalidate an otherwise usable access token.
    if (
        !current.accessToken ||
        current.status === "inactive" ||
        (current.accessTokenExpiresAt && current.accessTokenExpiresAt.epochMilliseconds <= now + 5_000)
    ) {
        yield* backend.applyAction({
            id: crypto.randomUUID(),
            name: "refreshConnection",
            parameters: { connectionId },
        });
        current = yield* read();
    }
    if (!current.accessToken)
        return yield* new BackendError({
            operation: "connect.read",
            kind: "Unauthenticated",
            retryable: false,
            message: "Access credentials are unavailable.",
        });
    const result = yield* backend.encrypted.decrypt({
        ...current.accessToken,
        source: { objectType: "OAuthConnection", primaryKey: connectionId, property: "accessToken" },
    });
    return yield* Schema.decodeUnknownEffect(Schema.String)(result.value).pipe(
        Effect.mapError(
            () =>
                new BackendError({
                    operation: "decrypt",
                    kind: "InvalidResponse",
                    retryable: false,
                    message: "Connection returned an invalid access token.",
                })
        )
    );
});
