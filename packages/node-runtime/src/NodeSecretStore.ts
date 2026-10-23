import { createHash } from "node:crypto";
import { make as makeNodeKeyring } from "@party-stack/effect-node-keyring";
import { RuntimeError, type SecretStore } from "@party-stack/runtime";
import { Effect, Redacted } from "effect";

export interface NodeSecretStoreOptions {
    service: string;
}
function encodeIdentifier(value: string): string {
    return `party-stack.${createHash("sha256").update(value).digest("hex")}`;
}

/** The native service is loaded on first use, once per scoped runtime. */
export const makeSecretStore = Effect.fnUntraced(function* (options: NodeSecretStoreOptions) {
    const service = encodeIdentifier(options.service);
    const keyring = yield* Effect.cached(
        makeNodeKeyring.pipe(
            Effect.mapError(
                () =>
                    new RuntimeError({
                        operation: "secrets.open",
                        cause: new Error("Native keyring unavailable."),
                    })
            )
        )
    );
    const operation = <A>(effect: Effect.Effect<A, unknown>) =>
        effect.pipe(
            Effect.mapError(
                () =>
                    new RuntimeError({
                        operation: "secrets",
                        cause: new Error("Native credential operation failed."),
                    })
            )
        );
    return {
        get: (key) =>
            operation(
                Effect.flatMap(keyring, (native) => native.getPassword(service, encodeIdentifier(key)))
            ).pipe(Effect.map((value) => (value === undefined ? undefined : Redacted.value(value)))),
        set: (key, value) =>
            operation(
                Effect.flatMap(keyring, (native) =>
                    native.setPassword(service, encodeIdentifier(key), Redacted.make(value))
                )
            ),
        delete: (key) =>
            operation(
                Effect.flatMap(keyring, (native) => native.deleteCredential(service, encodeIdentifier(key)))
            ).pipe(Effect.asVoid),
    } satisfies SecretStore;
});
