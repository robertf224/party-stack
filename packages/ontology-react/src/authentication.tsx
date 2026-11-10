"use client";

import { createAuthenticationClient } from "@party-stack/ontology/authentication";
import { createContext, useContext, useMemo } from "react";
import { useViewOptions } from "./options.js";
import { OwnedResource } from "./resource.js";
import { OntologyProvider, useOntologyEnvironment } from "./index.js";
import type { OntologyViewOptions } from "./options.js";
import type { AuthenticationClient } from "@party-stack/ontology/authentication";
import type { ReactNode } from "react";

const AuthenticationContext = createContext<AuthenticationClient | undefined>(undefined);

/** Own authentication commands and a reactive view of Connect's saved accounts. The
 * surrounding environment owns the transport and browser authentication runtime.
 */
export function AuthenticationProvider({
    ontology = "connect",
    children,
    ...props
}: OntologyViewOptions & {
    readonly ontology?: string;
    readonly children?: ReactNode;
}) {
    const environment = useOntologyEnvironment();
    const { client } = environment;
    const overrides = useViewOptions(props);
    const runtime = overrides.runtime ?? environment.runtime;
    const open = useMemo(
        () => () => createAuthenticationClient({ client, ontology, runtime }),
        [client, ontology, runtime]
    );
    return (
        <OwnedResource open={open}>
            {(authentication) => (
                <AuthenticationContext value={authentication}>
                    <OntologyProvider ontology={ontology} {...overrides}>
                        {children}
                    </OntologyProvider>
                </AuthenticationContext>
            )}
        </OwnedResource>
    );
}

/** Authentication actions run through Connect directly, outside a replica outbox. */
export function useAuthentication(): AuthenticationClient {
    const authentication = useContext(AuthenticationContext);
    if (!authentication) throw new Error("useAuthentication requires an AuthenticationProvider.");
    return authentication;
}
