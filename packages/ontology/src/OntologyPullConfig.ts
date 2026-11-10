import type { OntologyPullConfig as NativeConfig } from "@party-stack/ontology-backend/meta";
import type { Runtimes, RuntimesLayer } from "@party-stack/runtime";
export interface OntologyPullContext {
    readonly runtime: RuntimesLayer;
}
export type OntologyPullConfig = NativeConfig<Runtimes>;
