import { invariant } from "@bobbyfidz/panic";
import { createSharedClientContext } from "@osdk/shared.client.impl";
import type { SharedClient, SharedClientContext } from "@osdk/shared.client2";

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

export type Client = SharedClientContext;

export interface OntologyClient extends Client {
    ontologyRid: string;
}

export const createClient = (context: Optional<Client, "fetch">): Client => {
    // TODO: remove this dep and implement our own network setup here.
    return createSharedClientContext(
        context.baseUrl,
        context.tokenProvider,
        "foundry-ontology",
        context.fetch
    );
};

export function createOntologyClient(context: Optional<OntologyClient, "fetch">): OntologyClient {
    return {
        ...createClient(context),
        ontologyRid: context.ontologyRid,
    };
}

export function fromOsdkClient(client: SharedClient): OntologyClient {
    const context = client.__osdkClientContext;
    const ontologyRid = (context as unknown as { ontologyRid: string }).ontologyRid;
    invariant(ontologyRid, "Ontology rid not found on OSDK client, this should never happen.");
    return {
        ...context,
        ontologyRid,
    };
}
