import { createLiveOntology } from "@party-stack/ontology";
import { makeRemoteOntologyBackend } from "./backend.js";
import type { RemoteOntologyTransport } from "./protocol.js";
export { makeRemoteOntologyBackend } from "./backend.js";
import type {
    CreateLiveOntologyOpts,
    LiveOntology,
    LiveOntologyAction,
    OntologyDefinition,
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
    OntologyIR,
    OntologyApplyActionResult,
} from "@party-stack/ontology";

export interface OntologyApplyActionClientResult extends OntologyApplyActionResult {
    invalidatedObjectTypes?: string[];
}

export interface CreateRemoteOntologyBackendAdapterOptions {
    ir: OntologyIR;
    transport: RemoteOntologyTransport;

    supportsIdempotency?: boolean;
    journal?: boolean;
}

export type CreateRemoteOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (
    | {
          transport: RemoteOntologyTransport;
      }
    | {
          createTransport: (
              ir: OntologyIR,
              context: Context
          ) => RemoteOntologyTransport | Promise<RemoteOntologyTransport>;
      }
) & {
    supportsIdempotency?: boolean;
    journal?: boolean;
};

export interface CreateRemoteLiveOntologyOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> {
    transport: RemoteOntologyTransport;
    id?: string;
    runtime?: CreateLiveOntologyOpts<Context>["runtime"];
    persistObjects?: CreateLiveOntologyOpts<Context>["persistObjects"];
    writes?: CreateLiveOntologyOpts<Context>["writes"];
}

/** @deprecated Use makeOntologyServer / connectOntologyBackendHttp with scoped native backends. */
export function createRemoteOntologyBackendAdapter(
    opts: CreateRemoteOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    return { name: "remote", open: () => makeRemoteOntologyBackend(opts) };
}

/** @deprecated Use makeOntologyServer / connectOntologyBackendHttp with scoped native backends. */
export function createRemoteOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateRemoteOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createRemoteOntologyBackendAdapter({
            ir,
            transport: "transport" in opts ? opts.transport : await opts.createTransport(ir, context),

            supportsIdempotency: opts.supportsIdempotency,
            journal: opts.journal,
        });
}

export async function createRemoteLiveOntology<
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateRemoteLiveOntologyOptions<Context>): Promise<LiveOntology<Ontology>> {
    const description = await opts.transport.describe();
    const backend = createRemoteOntologyBackend<Context>({
        transport: opts.transport,
    });
    const resolveActionParameters = opts.transport.resolveActionParameters;
    const ontology = await createLiveOntology<Ontology, Context>({
        ir: description.ir,
        backend,
        id: opts.id,
        runtime: opts.runtime,
        persistObjects: opts.persistObjects,
        writes: opts.writes,
        context: (description.context ?? {}) as Context,
    });
    if (description.capabilities?.actionParameterResolution === true && resolveActionParameters) {
        for (const actionType of description.ir.actionTypes) {
            const action = (ontology.actions as Record<string, LiveOntologyAction>)[actionType.name];
            if (!action) continue;
            action.resolveParameters = async (parameters) =>
                (
                    await resolveActionParameters({
                        actionType: actionType.name,
                        parameters,
                    })
                ).parameters;
        }
    }
    return ontology;
}
