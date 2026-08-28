import type { Connection } from "@party-stack/connections";
import type { RuntimeAdapterProvider } from "@party-stack/runtime";
import type { OntologyBackendInstallation } from "./installation/types.js";
import type { OntologyIR } from "./ir/generated/types.js";

export interface OntologyPullContext {
    runtime: RuntimeAdapterProvider;
}

export interface OntologyPullSource<AuthenticationClient extends object = object> {
    ontologyId: string;
    createInstallation: (
        context: OntologyPullContext
    ) =>
        | OntologyBackendInstallation<AuthenticationClient>
        | Promise<OntologyBackendInstallation<AuthenticationClient>>;
    resolveConnection: (
        installation: OntologyBackendInstallation<AuthenticationClient>
    ) => Connection<"active"> | Promise<Connection<"active">>;
    transformPulledOntology?: (ontology: OntologyIR) => OntologyIR | Promise<OntologyIR>;
}

export interface OntologyPullConfig<AuthenticationClient extends object = object> {
    source: OntologyPullSource<AuthenticationClient>;
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryFunctionTypeNames?: string[];
}
