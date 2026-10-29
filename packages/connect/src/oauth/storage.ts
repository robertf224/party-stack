import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Effect } from "effect";
import { connectError } from "../core/errors.js";
import type { ConnectCredentialValues } from "../core/Connect.js";
import type { ConnectError } from "../core/errors.js";
import type { RuntimeService } from "@party-stack/runtime";

/** Credentials use embedded ciphertext in Tables; only the keyring owns encryption keys. */
export function runtimeCredentialValues(
    runtime: RuntimeService,
    namespace: string
): Effect.Effect<ConnectCredentialValues, ConnectError> {
    if (!runtime.encryptionKeyring)
        return Effect.fail(
            connectError(
                "Configuration",
                "OAuth requires an encryption keyring. Configure platform key storage; persistent browser runtimes must explicitly opt into persistEncryptionKeys."
            )
        );
    return Effect.succeed({
        ...makeEncryptedValues(namespace, runtime.encryptionKeyring),
        evict: () => Effect.void,
    });
}
