import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import type { ConnectStore } from "./store.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { TablesService } from "@party-stack/ontology-storage/tables";

/** Import earlier Connect schemas without changing credential encryption AAD.
 * New commits precede old-row deletion. A crash can repeat a batch but cannot replace
 * an already imported/refreshed credential. Old journal cursors stay in the old namespace.
 */
export const migrateConnectCredentials = Effect.fn("Connect.migrate")(function* (options: {
    tables: TablesService;
    namespace: string;
    ir: OntologyIR;
    store: ConnectStore;
}) {
    const schemas = compileEffectSchemas(options.ir).objectSchemas;
    const legacyNames = [
        ["Installation", "ServiceInstance"],
        ["OAuthConnector", "OAuthApplication"],
        ["OAuthConnection", "OAuthConnection"],
        ["OAuthAuthorizationAttempt", "OAuthAuthorizationAttempt"],
    ] as const;
    const serviceNames = [
        ["ServiceInstance", "ServiceInstance"],
        ["OAuthApplication", "OAuthApplication"],
        ["OAuthConnection", "OAuthConnection"],
        ["OAuthAuthorizationAttempt", "OAuthAuthorizationAttempt"],
        ["ApiKeyConnection", "ApiKeyConnection"],
        ["ExternalSessionConnection", "ExternalSessionConnection"],
    ] as const;
    for (const source of [
        { namespace: JSON.stringify([options.namespace, "connect", 2]), names: serviceNames, legacy: false },
        { namespace: options.namespace, names: legacyNames, legacy: true },
    ]) {
        for (const [previous, current] of source.names) {
            const table = Table.make<Record<string, unknown>>({
                name: JSON.stringify(["ontology", source.namespace, "object", previous]),
            });
            while (true) {
                const batch = yield* options.tables.query(table, { limit: 100 });
                yield* options.store.transaction(
                    Effect.gen(function* () {
                        for (const { value } of batch) {
                            const id = value.id as string;
                            if (yield* options.store.get(current, id)) continue;
                            const {
                                providerId,
                                providerAppId,
                                providerSubjectId,
                                installation,
                                connector,
                                ...rest
                            } = value;
                            const converted = source.legacy
                                ? {
                                      ...rest,
                                      ...(previous === "Installation" ? { service: providerId } : {}),
                                      ...(previous === "OAuthConnector"
                                          ? { serviceInstance: installation, serviceAppId: providerAppId }
                                          : {}),
                                      ...(previous === "OAuthConnection" ||
                                      previous === "OAuthAuthorizationAttempt"
                                          ? { application: connector }
                                          : {}),
                                      ...(previous === "OAuthConnection"
                                          ? { userId: providerSubjectId }
                                          : {}),
                                  }
                                : value;
                            const decoded = yield* Schema.decodeUnknownEffect(schemas[current]!)(converted);
                            yield* options.store.put(current, decoded as never);
                        }
                    })
                );
                yield* options.tables.transaction((tx) =>
                    Effect.forEach(batch, ({ key }) => tx.delete(table, key), { discard: true })
                );
                if (batch.length < 100) break;
            }
        }
    }
});
