import { Context, Effect, Layer, Redacted, Schema } from "effect";

export class KeyringError extends Schema.TaggedError<KeyringError>()("KeyringError", {
    operation: Schema.Literals(["load", "get", "set", "delete"]),
    kind: Schema.Literals(["Unavailable", "OperationFailed"]),
    message: Schema.String,
}) {}

export interface NodeKeyringService {
    readonly getPassword: (
        service: string,
        account: string
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, KeyringError>;
    readonly setPassword: (
        service: string,
        account: string,
        password: Redacted.Redacted<string>
    ) => Effect.Effect<void, KeyringError>;
    readonly getSecret: (
        service: string,
        account: string
    ) => Effect.Effect<Redacted.Redacted<Uint8Array> | undefined, KeyringError>;
    readonly setSecret: (
        service: string,
        account: string,
        secret: Redacted.Redacted<Uint8Array>
    ) => Effect.Effect<void, KeyringError>;
    /** True means deleted; false means absent. Failures remain errors. */
    readonly deleteCredential: (service: string, account: string) => Effect.Effect<boolean, KeyringError>;
}

export class NodeKeyring extends Context.Service<NodeKeyring, NodeKeyringService>()(
    "@party-stack/effect-node-keyring/NodeKeyring"
) {
    static readonly layer = Layer.effect(
        NodeKeyring,
        Effect.suspend(() => make)
    );
}

/** Load the required native binding without accessing any credential. No CLI or file fallback. */
export const make: Effect.Effect<NodeKeyringService, KeyringError> = Effect.gen(function* () {
    const native = yield* Effect.tryPromise({
        try: () => import("@napi-rs/keyring"),
        catch: () =>
            new KeyringError({
                operation: "load",
                kind: "Unavailable",
                message:
                    "The native OS keyring binding could not be loaded. Check the platform binary and application packaging.",
            }),
    });
    const attempt = <A>(
        operation: "get" | "set" | "delete",
        service: string,
        account: string,
        run: (entry: InstanceType<typeof native.AsyncEntry>, signal: AbortSignal) => Promise<A>
    ) =>
        Effect.tryPromise({
            try: (signal) =>
                run(new native.AsyncEntry(service, account, { linux: { store: "secret-service" } }), signal),
            // Native errors may contain credential identifiers or values. Do not attach them as causes.
            catch: () =>
                new KeyringError({
                    operation,
                    kind: "OperationFailed",
                    message:
                        "OS keyring operation failed. The credential store may be locked or unavailable.",
                }),
        });
    return NodeKeyring.of({
        getPassword: (service, account) =>
            attempt("get", service, account, (entry, signal) => entry.getPassword(signal)).pipe(
                Effect.map((value) => (value == null ? undefined : Redacted.make(value)))
            ),
        setPassword: (service, account, password) =>
            attempt("set", service, account, (entry, signal) =>
                entry.setPassword(Redacted.value(password), signal)
            ),
        getSecret: (service, account) =>
            attempt("get", service, account, (entry, signal) => entry.getSecret(signal)).pipe(
                Effect.map((value) => (value == null ? undefined : Redacted.make(Uint8Array.from(value))))
            ),
        setSecret: (service, account, secret) =>
            attempt("set", service, account, (entry, signal) =>
                entry.setSecret(Redacted.value(secret), signal)
            ),
        deleteCredential: (service, account) =>
            attempt("delete", service, account, (entry, signal) => entry.deleteCredential(signal)),
    });
});
