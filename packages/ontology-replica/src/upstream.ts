import { Context } from "effect";
import type { ConnectionMonitor } from "@party-stack/connect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
export type ReplicaUpstreamService =
    | {
          readonly kind: "committed";
          readonly backend: OntologyBackendService;
          readonly connection?: Pick<ConnectionMonitor, "state" | "changes">;
      }
    | {
          readonly kind: "speculative";
          readonly backend: OntologyBackendService;
          readonly source: OntologySource;
          readonly connection?: Pick<ConnectionMonitor, "state" | "changes">;
      };
/** Acquired upstream capabilities. Platform storage remains supplied by Runtime. */
export class ReplicaUpstream extends Context.Service<ReplicaUpstream, ReplicaUpstreamService>()(
    "@party-stack/ontology-replica/ReplicaUpstream"
) {}
