import { invariant } from "@bobbyfidz/panic";
import { createFetchOrThrow } from "@osdk/shared.net.fetch";
import { createFoundryFetch, createFoundryWebSocket } from "./network.js";
import type { SharedClient, SharedClientContext } from "@osdk/shared.client2";

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

export interface Client extends SharedClientContext {
    createWebSocket?: (url: string | URL, protocols?: string | string[]) => Promise<WebSocket>;
}

export interface OntologyClient extends Client {
    ontologyRid: string;
}

function normalizeBaseUrl(baseUrl: string): string {
    const normalized = new URL(baseUrl);
    if (!normalized.pathname.endsWith("/")) {
        normalized.pathname += "/";
    }
    return normalized.toString();
}

export function createClient(context: Optional<Client, "fetch">): Client {
    const baseUrl = normalizeBaseUrl(context.baseUrl);
    const fetchImpl =
        context.fetch ??
        createFoundryFetch({
            baseUrl,
            tokenProvider: context.tokenProvider,
        });
    return {
        baseUrl,
        fetch: createFetchOrThrow(fetchImpl),
        tokenProvider: context.tokenProvider,
        createWebSocket:
            context.createWebSocket ??
            createFoundryWebSocket({
                baseUrl,
                tokenProvider: context.tokenProvider,
            }),
    };
}

export function createOntologyClient(context: Optional<OntologyClient, "fetch">): OntologyClient {
    return {
        ...createClient(context),
        ontologyRid: context.ontologyRid,
    };
}

export function fromOsdkClient(client: SharedClient): OntologyClient {
    const context = client.__osdkClientContext;
    const ontologyRid = (
        context as unknown as {
            ontologyRid: string;
        }
    ).ontologyRid;
    invariant(ontologyRid, "Ontology rid not found on OSDK client, this should never happen.");
    return {
        ...context,
        ontologyRid,
    };
}
