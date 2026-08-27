import type {
    BackendConnectionAdapterProvider,
    Connection,
    ConnectionEgress,
} from "@party-stack/connections";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";
import type { OntologyIR } from "../ir/index.js";
import type { CreateLiveOntologyOpts, LiveOntology, OntologyDefinition } from "../live/LiveOntology.js";
import type { OntologyBackendAdapterProvider } from "../live/OntologyBackendAdapter.js";
import type { Collection } from "@tanstack/db";

export interface ConfigureOntologyOptions {
    connection: Connection<"active">;
    egress: ConnectionEgress;
    ontologyId: string;
}

export interface OntologyConfiguration {
    ir: OntologyIR;
    backend: OntologyBackendAdapterProvider;
    context?: Record<string, unknown>;
    persistObjects?: boolean;
    writes?: CreateLiveOntologyOpts["writes"];
}

export interface OntologyRoute {
    matches(ontologyId: string): boolean;
    configure(options: ConfigureOntologyOptions): OntologyConfiguration | Promise<OntologyConfiguration>;
}

export interface CreateOntologyBackendInstallationOptions<AuthenticationClient extends object = object> {
    /**
     * Stable identity for one deployed backend and authentication domain.
     * Every ontology route must be usable through this installation's
     * connections and egress.
     */
    installationId: string;
    connections: BackendConnectionAdapterProvider<AuthenticationClient>;
    runtime: RuntimeAdapterProvider;
    routes: readonly OntologyRoute[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
}

export interface OntologyBackendInstallation<AuthenticationClient extends object = object> {
    readonly installationId: string;
    readonly authentication: AuthenticationClient;
    readonly connections: Collection<
        Connection,
        string
    >;

    /**
     * Opens or returns the cached LiveOntology for one user and ontology ID.
     * The user must have an active connection to this installation.
     */
    openOntology<Ontology extends OntologyDefinition = OntologyDefinition>(options: {
        userId: string;
        ontologyId: string;
    }): Promise<LiveOntology<Ontology>>;
    /**
     * Releases one cached LiveOntology and its process-local resources without
     * disconnecting the user's backend session or deleting durable local data
     * and pending writes.
     */
    closeOntology(options: {
        userId: string;
        ontologyId: string;
    }): Promise<void>;
    /**
     * Logs the user out of this backend installation.
     *
     * Closes every LiveOntology using the user's connection, then delegates to
     * the connection session to revoke, sign out, or deactivate its
     * credentials. The persisted Connection remains inactive. Local ontology
     * data and pending writes are retained.
     */
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
