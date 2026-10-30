import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { makeOntologyStorage, makeStorageModel, field } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { connectOntology } from "../spec/index.js";
import { connectError, type ConnectError } from "./errors.js";
import type {
    OAuthConnectionRecord,
    OAuthConnectorRecord,
    InstallationRecord,
    OAuthAuthorizationAttemptRecord,
} from "../spec/index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { ObjectStore, Query } from "@party-stack/ontology-storage";
import type { TablesService } from "@party-stack/ontology-storage/tables";

type Records = {
    Installation: InstallationRecord;
    OAuthConnector: OAuthConnectorRecord;
    OAuthConnection: OAuthConnectionRecord;
    OAuthAuthorizationAttempt: OAuthAuthorizationAttemptRecord;
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
export const makeConnectStore = Effect.fn("Connect.store")(function* (options: {
    tables: TablesService;
    namespace: string;
    ir?: OntologyIR;
}) {
    const ir = options.ir ?? connectOntology;
    const model = yield* makeStorageModel({ namespace: options.namespace, ir });
    const storage = makeOntologyStorage(model, options.tables);
    const object = <N extends keyof Records>(name: N) =>
        model.objects[name] as ObjectStore<Records[N], string>;
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
    for (const [name, fields] of Object.entries({
        OAuthConnector: ["installation"],
        OAuthConnection: ["connector", "accessTokenExpiresAt", "refreshTokenExpiresAt", "operationExpiresAt"],
        OAuthAuthorizationAttempt: ["expiresAt", "connector"],
    }))
        for (const property of fields)
            yield* protect(
                storage.ensureIndex(object(name as keyof Records), {
                    name: property,
                    field: field(property),
                })
            );
    return {
        get: (name, id) => protect(storage.get(object(name), id)),
        put: (name, value) => protect(storage.put(object(name), value)),
        delete: (name, id) => protect(storage.delete(object(name), id)),
        load: (name, query) =>
            protect(storage.query(object(name), query)).pipe(
                Effect.map((rows) => rows.map((row) => row.value))
            ),
        transaction: (body) =>
            storage
                .withTransaction(body)
                .pipe(
                    Effect.catchTag("OntologyStorageError", () =>
                        Effect.fail(connectError("Storage", "Connect transaction failed.", true))
                    )
                ),
    } satisfies ConnectStore;
});
