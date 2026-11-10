import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { field } from "@party-stack/ontology-storage";
import { Context, Effect } from "effect";
import { connectOntology } from "../spec/index.js";
import { connectError, type ConnectError } from "./errors.js";
import { migrateConnectCredentials } from "./migrate.js";
import type {
    OAuthConnectionRecord,
    OAuthApplicationRecord,
    ServiceInstanceRecord,
    OAuthAuthorizationAttemptRecord,
    ApiKeyConnectionRecord,
    ExternalSessionConnectionRecord,
} from "../spec/index.js";
import type { OwnedReadTransaction, OwnedStorageTransaction } from "@party-stack/ontology-backend/owned";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Query } from "@party-stack/ontology-storage";
import type { TablesService } from "@party-stack/ontology-storage/tables";

type Records = {
    ServiceInstance: ServiceInstanceRecord;
    OAuthApplication: OAuthApplicationRecord;
    OAuthConnection: OAuthConnectionRecord;
    OAuthAuthorizationAttempt: OAuthAuthorizationAttemptRecord;
    ApiKeyConnection: ApiKeyConnectionRecord;
    ExternalSessionConnection: ExternalSessionConnectionRecord;
};
/** Remote implementations may implement this boundary with trusted ontology actions.
 * transaction must atomically enforce the read/write decisions in its body.
 */
export interface ConnectStore {
    get<N extends keyof Records>(name: N, id: string): Effect.Effect<Records[N] | undefined, ConnectError>;
    put<N extends keyof Records>(name: N, value: Records[N]): Effect.Effect<void, ConnectError>;
    delete<N extends keyof Records>(name: N, id: string): Effect.Effect<void, ConnectError>;
    load<N extends keyof Records>(name: N, query: Query): Effect.Effect<Records[N][], ConnectError>;
    transaction<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E | ConnectError, R>;
}

/** Additional application properties are validated and preserved by the compiled ontology. */
export const makeConnectPersistence = Effect.fn("Connect.persistence")(function* (options: {
    tables: TablesService;
    namespace: string;
    ir?: OntologyIR;
    maintenance?: false | { readonly intervalMs?: number };
}) {
    const ir = options.ir ?? connectOntology;
    const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
            Effect.mapError(() => connectError("Storage", "Connect storage operation failed.", true))
        );
    // Compile application extensions, then check that every standard property remains compatible.
    yield* Effect.try({
        try: () => {
            for (const base of connectOntology.objectTypes) {
                const definition = ir.objectTypes.find((candidate) => candidate.name === base.name);
                if (!definition || definition.primaryKey !== base.primaryKey) throw new Error();
                for (const property of base.properties) {
                    const actual = definition.properties.find(
                        (candidate) => candidate.name === property.name
                    );
                    if (!actual || JSON.stringify(actual.type) !== JSON.stringify(property.type))
                        throw new Error();
                }
            }
            compileEffectSchemas(ir);
        },
        catch: () =>
            connectError(
                "Configuration",
                "Connect definitions must retain their standard properties and primary keys."
            ),
    });
    const backend = yield* makeOwnedBackend({
        ...options,
        // Version 3 adds per-application OAuth scopes. Import v2 records below;
        // credential encryption uses options.namespace, so handles retain their AAD.
        namespace: JSON.stringify([options.namespace, "connect", 3]),
        ir,
        mutators: {},
    });
    // Each persistence instance has its own transaction binding. Nested calls compose;
    // concurrent effects and different Connect authorities never share a transaction.
    const CurrentTransaction = Context.Service<OwnedStorageTransaction>(
        `Connect.transaction:${crypto.randomUUID()}`
    );
    const inTransaction = <A, E, R>(body: (tx: OwnedStorageTransaction) => Effect.Effect<A, E, R>) =>
        Effect.serviceOption(CurrentTransaction).pipe(
            Effect.flatMap((current) =>
                current._tag === "Some" ? body(current.value) : backend.storage.transaction(body)
            )
        );
    const read = <A, E, R>(body: (tx: OwnedReadTransaction) => Effect.Effect<A, E, R>) =>
        Effect.serviceOption(CurrentTransaction).pipe(
            Effect.flatMap((current) =>
                current._tag === "Some" ? body(current.value) : backend.storage.read(body)
            )
        );
    const store: ConnectStore = {
        get: (name, id) =>
            protect(read((tx) => tx.get(name, id))).pipe(
                Effect.map((value) => value as Records[typeof name] | undefined)
            ),
        put: (name, value) => protect(inTransaction((tx) => tx.put(name, value))),
        delete: (name, id) => protect(inTransaction((tx) => tx.delete(name, id))),
        load: (name, query) =>
            protect(read((tx) => tx.loadSubset(name, query))).pipe(
                Effect.map((rows) => rows.map((row) => row.value as Records[typeof name]))
            ),
        transaction: (body) =>
            inTransaction((tx) => body.pipe(Effect.provideService(CurrentTransaction, tx))).pipe(
                Effect.catchTag("BackendError", () =>
                    Effect.fail(connectError("Storage", "Connect transaction failed.", true))
                )
            ),
    };
    for (const [name, fields] of Object.entries({
        OAuthApplication: ["serviceInstance", "connection"],
        OAuthConnection: [
            "application",
            "userId",
            "accessTokenExpiresAt",
            "refreshTokenExpiresAt",
            "operationExpiresAt",
        ],
        OAuthAuthorizationAttempt: ["expiresAt", "application", "connectionId"],
        ApiKeyConnection: ["serviceInstance", "userId", "expiresAt"],
        ExternalSessionConnection: ["serviceInstance", "userId", "sessionId", "expiresAt"],
    }))
        for (const property of fields)
            yield* protect(
                backend.storage.transaction((tx) =>
                    tx.ensureIndex(name, { name: property, field: field(property) })
                )
            );
    yield* protect(migrateConnectCredentials({ ...options, ir, store }));
    return { store, backend };
});

export const makeConnectStore = Effect.fn("Connect.store")(function* (
    options: Parameters<typeof makeConnectPersistence>[0]
) {
    return (yield* makeConnectPersistence(options)).store;
});
