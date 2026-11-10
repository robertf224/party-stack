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

export type ClientOptions =
    | Optional<Client, "fetch">
    | (Omit<Client, "tokenProvider" | "createWebSocket"> & {
          tokenProvider?: never;
          createWebSocket?: Client["createWebSocket"];
      });
export function createClient(context: ClientOptions): Client {
    const baseUrl = normalizeBaseUrl(context.baseUrl);
    // Authenticated egress owns credentials. SDK code must use its fetch/WebSocket,
    // rather than requesting a token separately or injecting a placeholder credential.
    const tokenProvider =
        context.tokenProvider ??
        (() =>
            Promise.reject(
                new Error("This client uses authenticated egress; direct token access is unavailable.")
            ));
    const fetchImpl =
        context.fetch ??
        createFoundryFetch({
            baseUrl,
            tokenProvider,
        });
    return {
        baseUrl,
        fetch: createFetchOrThrow(fetchImpl),
        tokenProvider,
        createWebSocket:
            context.createWebSocket ??
            (context.tokenProvider ? createFoundryWebSocket({ baseUrl, tokenProvider }) : undefined),
    };
}

export function createOntologyClient(context: ClientOptions & { ontologyRid: string }): OntologyClient {
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
