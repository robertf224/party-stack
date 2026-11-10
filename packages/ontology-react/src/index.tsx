"use client";
import { OntologyContext } from "./context.js";
export { useOntology } from "./context.js";

import { createLiveOntology, createOntologyClient } from "@party-stack/ontology";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { DbProvider } from "@tanstack/react-db";
import { Effect } from "effect";
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { AttachmentResourcesContext, makeAttachmentResources } from "./attachmentResources.js";
import { useViewOptions } from "./options.js";
import { OwnedResource, OwnedResourceLease, OwnedValue } from "./resource.js";
import type { AttachmentPromiseCache } from "./attachmentPromiseCache.js";
import type { OntologyViewOptions } from "./options.js";
import type {
    CreateLiveOntologyOpts,
    LiveOntology,
    OntologyDefinition,
    OntologyIR,
    OntologyServerClient,
    BackendError,
} from "@party-stack/ontology";
import type { Scope } from "effect";
import type { ReactNode } from "react";

export { defineFragment, defineListFragment } from "@party-stack/db-fragments";
export { useFragment, useListFragment } from "@party-stack/db-fragments/react";
export type {
    FragmentData,
    FragmentRef,
    FragmentCollection,
    ListFragmentRef,
    ListFragmentData,
} from "@party-stack/db-fragments";

export { useAttachmentUrl, useAttachmentMetadata } from "./attachments.js";
export { useOfflinePin } from "./pins.js";

export { ontologyCollections } from "@party-stack/ontology/tanstack";
export type { OntologyViewOptions } from "./options.js";

export type OntologyEnvironmentProviderProps = OntologyViewOptions & {
    readonly client: OntologyServerClient | Effect.Effect<OntologyServerClient, BackendError, Scope.Scope>;
    readonly children?: ReactNode;
};
type OntologyEnvironment = OntologyViewOptions & { readonly client: OntologyServerClient };
const EnvironmentContext = createContext<OntologyEnvironment | undefined>(undefined);

/** Own one transport and supply default construction settings for independent local views. */
export function OntologyEnvironmentProvider({
    client,
    children,
    ...props
}: OntologyEnvironmentProviderProps) {
    const defaults = useViewOptions(props);
    const open = useMemo(
        () => (Effect.isEffect(client) ? () => createOntologyClient(client) : undefined),
        [client]
    );
    return open ? (
        <OwnedResourceLease open={open}>
            {(promise) => (
                <OpeningEnvironmentValue promise={promise} defaults={defaults}>
                    {children}
                </OpeningEnvironmentValue>
            )}
        </OwnedResourceLease>
    ) : (
        <EnvironmentValue client={client as OntologyServerClient} defaults={defaults}>
            {children}
        </EnvironmentValue>
    );
}
function OpeningEnvironmentValue({
    promise,
    defaults,
    children,
}: {
    readonly promise: ReturnType<typeof createOntologyClient>;
    readonly defaults: OntologyViewOptions;
    readonly children?: ReactNode;
}) {
    const client = useMemo<OntologyServerClient>(() => {
        // The environment owns the transport. Child openings borrow the same
        // acquisition instead of waiting for a separate React reveal to mount.
        const transport = Effect.tryPromise({
            try: () => promise,
            catch: (cause) => classifyBackendFailure("ontology.client", cause),
        });
        return {
            ontology: (name, options) =>
                Effect.flatMap(transport, (client) => client.ontology(name, options)),
        };
    }, [promise]);
    return (
        <EnvironmentValue client={client} defaults={defaults}>
            {children}
        </EnvironmentValue>
    );
}
function EnvironmentValue({
    client,
    defaults,
    children,
}: {
    readonly client: OntologyServerClient;
    readonly defaults: OntologyViewOptions;
    readonly children?: ReactNode;
}) {
    const value = useMemo(() => ({ ...defaults, client }), [client, defaults]);
    return <EnvironmentContext value={value}>{children}</EnvironmentContext>;
}
export function useOntologyEnvironment() {
    const environment = useContext(EnvironmentContext);
    if (!environment) throw new Error("An OntologyEnvironmentProvider is required.");
    return environment;
}

type ConstructedOntologyOptions =
    | CreateLiveOntologyOpts
    | (OntologyViewOptions & {
          readonly ontology?: string;
          readonly ir?: OntologyIR;
          readonly client?: never;
          readonly backend?: never;
      });
export type OntologyProviderProps<Definition extends OntologyDefinition> = {
    readonly children?: ReactNode;
} & ({ readonly ontology: LiveOntology<Definition> } | ConstructedOntologyOptions);

/** Existing views are borrowed. Construction props inherit environment defaults;
 * an explicit backend/client overrides the environment's transport. Owned views
 * close on selection change/unmount and report acquisition errors to React.
 */
export function OntologyProvider<Definition extends OntologyDefinition>(
    props: OntologyProviderProps<Definition>
) {
    if (props.ontology && typeof props.ontology !== "string")
        return <BorrowedViewProvider ontology={props.ontology}>{props.children}</BorrowedViewProvider>;
    return (
        <ConstructedProvider<Definition> {...(props as ConstructedOntologyOptions)}>
            {props.children}
        </ConstructedProvider>
    );
}
function ConstructedProvider<Definition extends OntologyDefinition>({
    children,
    ...props
}: ConstructedOntologyOptions & { readonly children?: ReactNode }) {
    const environment = useContext(EnvironmentContext);
    const defaults = useViewOptions(environment ?? {});
    const overrides = useViewOptions(props);
    const backend = props.backend;
    const client = props.client ?? environment?.client;
    const ir = props.ir;
    const ontology = props.ontology;
    const options = useMemo<CreateLiveOntologyOpts>(() => {
        const settings = { ...defaults, ...overrides };
        if (backend) return { ...settings, ir: ir!, backend };
        if (!client) throw new Error("Supply a backend, a client, or an OntologyEnvironmentProvider.");
        return { ...settings, ir, client, ontology };
    }, [defaults, overrides, backend, client, ir, ontology]);
    const open = useMemo(
        () => async () => {
            const ontology = await createLiveOntology<Definition>(options);
            const resources = makeAttachmentResources();
            return {
                ontology,
                resources,
                cleanup: async () => {
                    await resources.cleanup();
                    await ontology.cleanup();
                },
            };
        },
        [options]
    );
    return (
        <OwnedResource open={open}>
            {({ ontology, resources }) => (
                <ViewProvider ontology={ontology} attachments={resources.cache}>
                    {children}
                </ViewProvider>
            )}
        </OwnedResource>
    );
}

const subscribeClient = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function BorrowedViewProvider<Definition extends OntologyDefinition>({
    ontology,
    children,
}: {
    readonly ontology: LiveOntology<Definition>;
    readonly children?: ReactNode;
}) {
    const client = useSyncExternalStore(subscribeClient, clientSnapshot, serverSnapshot);
    const open = useMemo(() => () => makeAttachmentResources(), [ontology]);
    // Borrowed views still render during SSR. On the client an independent owner
    // commits before attachment readers can suspend, without owning the ontology.
    if (!client) return <ViewProvider ontology={ontology}>{children}</ViewProvider>;
    return (
        <OwnedValue open={open}>
            {({ cache }) => (
                <ViewProvider ontology={ontology} attachments={cache}>
                    {children}
                </ViewProvider>
            )}
        </OwnedValue>
    );
}

function ViewProvider<Definition extends OntologyDefinition>({
    ontology,
    attachments,
    children,
}: {
    readonly ontology: LiveOntology<Definition>;
    readonly attachments?: AttachmentPromiseCache;
    readonly children?: ReactNode;
}) {
    return (
        <OntologyContext value={ontology as unknown as LiveOntology}>
            <AttachmentResourcesContext value={attachments}>
                <DbProvider client={ontology.dbClient}>{children}</DbProvider>
            </AttachmentResourcesContext>
        </OntologyContext>
    );
}
