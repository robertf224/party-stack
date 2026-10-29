import type { CreateLiveOntologyOpts, LiveOntology, OntologyDefinition } from "../live/LiveOntology.js";
import type { OntologyBackendAdapterProvider } from "../live/OntologyBackendAdapter.js";
import type {
    BackendConnectionAdapterProvider,
    Connection,
    ConnectionEgress,
    ConnectionMonitor,
} from "@party-stack/connect";
import type { BackendError } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { MetaOntology } from "@party-stack/ontology-spec/meta";
import type { RuntimeLayer } from "@party-stack/runtime";
import type { Effect, Stream } from "effect";

export interface ConfigureOntologyOptions {
    connection: Connection<"active">;
    egress: ConnectionEgress;
    ontologyId: string;
}

export interface OntologyConfiguration {
    ir: OntologyIR;
    backend: OntologyBackendAdapterProvider;
    context?: Record<string, unknown>;
    writes?: CreateLiveOntologyOpts["writes"];
}

export interface OntologyRoute {
    matches(ontologyId: string): boolean;
    configure?(options: ConfigureOntologyOptions): OntologyConfiguration | Promise<OntologyConfiguration>;
    configureMeta?(options: ConfigureOntologyOptions): OntologyConfiguration | Promise<OntologyConfiguration>;
}

export interface OntologyBackendInstallationOptions<AuthenticationClient extends object = object> {
    /**
     * Stable identity for one deployed backend and authentication domain.
     * Every ontology route must be usable through this installation's
     * connections and egress.
     */
    installationId: string;
    connections: BackendConnectionAdapterProvider<AuthenticationClient>;
    routes: readonly OntologyRoute[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
    /** Application placement boundary. Metadata keeps its normal local construction. */
    openOntology?: (
        options: CreateLiveOntologyOpts & { installationId: string; userId: string; ontologyId: string }
    ) => Promise<LiveOntology>;
}

/** Framework composition supplies a configured platform Layer, never a callback factory. */
export interface CreateOntologyBackendInstallationOptions<
    AuthenticationClient extends object = object,
> extends OntologyBackendInstallationOptions<AuthenticationClient> {
    runtime: RuntimeLayer;
}

export interface OntologyBackendInstallation<AuthenticationClient extends object = object> {
    readonly installationId: string;
    readonly authentication: AuthenticationClient;
    readonly connections: ReadonlyMap<string, Connection>;
    readonly connectionChanges: Stream.Stream<readonly Connection[]>;
    connectionMonitor(userId: string): ConnectionMonitor;

    /**
     * Opens or returns the cached LiveOntology for one user and ontology ID.
     * The user must have an active connection to this installation.
     */
    openOntology<Ontology extends OntologyDefinition = OntologyDefinition>(options: {
        userId: string;
        ontologyId: string;
    }): Promise<LiveOntology<Ontology>>;
    openMetaOntology(options: { userId: string; ontologyId: string }): Promise<LiveOntology<MetaOntology>>;
    closeMetaOntology(options: { userId: string; ontologyId: string }): Promise<void>;
    /**
     * Releases one cached LiveOntology and its process-local resources without
     * disconnecting the user's backend session or deleting durable local data
     * and pending writes.
     */
    closeOntology(options: { userId: string; ontologyId: string }): Promise<void>;
    /**
     * Logs the user out of this backend installation.
     *
     * Closes every LiveOntology using the user's connection, then delegates to
     * the connection session to revoke, sign out, or deactivate its
     * credentials. The persisted Connection remains inactive. Local ontology
     * data and pending writes are retained.
     */
    refreshConnections(): Promise<void>;
    disconnect(userId: string): Promise<void>;
    /**
     * Logs the user out and removes the persisted Connection from this
     * installation. Every indexed local ontology partition for the user,
     * including durable objects, blobs, and pending writes, is destroyed.
     * Remote backend data and provider accounts are not deleted.
     */
    forget(userId: string): Promise<void>;
    /**
     * Releases every open LiveOntology and all installation process resources.
     *
     * This does not revoke credentials, mark connections inactive, or delete
     * durable local data. A later installation instance may restore persisted
     * connections and reopen ontologies.
     */
    cleanup(): Promise<void>;
}

/** Effect service. The installation's Scope owns every cached ontology. */
export interface OntologyBackendInstallationService<A extends object = object> {
    readonly installationId: string;
    readonly authentication: A;
    readonly connections: ReadonlyMap<string, Connection>;
    readonly connectionChanges: Stream.Stream<readonly Connection[]>;
    connectionMonitor(userId: string): ConnectionMonitor;
    openOntology<T extends OntologyDefinition = OntologyDefinition>(options: {
        userId: string;
        ontologyId: string;
    }): Effect.Effect<LiveOntology<T>, BackendError>;
    openMetaOntology(options: {
        userId: string;
        ontologyId: string;
    }): Effect.Effect<LiveOntology<MetaOntology>, BackendError>;
    closeOntology(options: {
        userId: string;
        ontologyId: string;
        ifReplica?: LiveOntology["storage"];
    }): Effect.Effect<void, BackendError>;
    closeMetaOntology(options: {
        userId: string;
        ontologyId: string;
        ifReplica?: LiveOntology["storage"];
    }): Effect.Effect<void, BackendError>;
    refreshConnections(): Effect.Effect<void, BackendError>;
    disconnect(userId: string): Effect.Effect<void, BackendError>;
    forget(userId: string): Effect.Effect<void, BackendError>;
}
