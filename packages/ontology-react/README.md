# React ontologies

Let the provider open and close a view, or supply an existing one. Query components can use module-level collection
descriptors; they do not need to pass a client or call an ontology hook.

```tsx
import { OntologyProvider } from "@party-stack/ontology-react";
import { httpClient } from "@party-stack/ontology/http";
import { webRuntime } from "@party-stack/web-runtime";
import { Suspense } from "react";

const options = {
    client: httpClient("/api/ontology/rpc"),
    runtime: webRuntime({ storage: "memory" }),
};

<Suspense fallback={<p>Opening…</p>}>
    <OntologyProvider {...options}>
        <Issues />
    </OntologyProvider>
</Suspense>;
```

Construction inputs are lazy. Keep object-valued props stable between renders. The provider
acquires after mounting, suspends through your parent boundary while opening, and
closes the view when options change or it unmounts. Startup failures reach the
nearest error boundary. No browser resources open during server rendering.

For a view acquired elsewhere:

```tsx
import { OntologyProvider } from "@party-stack/ontology-react";
import { eq, useLiveSuspenseQuery } from "@tanstack/react-db";
import { objects } from "./ontology/generated/collections";
import type { AppOntology } from "./ontology/generated/types";

function Issues() {
    const { data } = useLiveSuspenseQuery({
        query: (q) => q.from({ issue: objects.Issue }).where(({ issue }) => eq(issue.status, "Open")),
    });
    return (
        <ul>
            {data.map((issue) => (
                <li key={issue.id}>{issue.title}</li>
            ))}
        </ul>
    );
}

<Suspense fallback={<p>Loading issues…</p>}>
    <OntologyProvider ontology={ontology}>
        <Issues />
    </OntologyProvider>
</Suspense>;
```

The provider borrows an existing view. Its owner calls `ontology.cleanup()`.
`ontology generate` emits `generated/collections.ts`. You can also declare descriptors
manually with a primary-key map, such as `ontologyCollections<AppOntology>({ Issue: "id" })`.
Descriptors and `ontology.objects` resolve to the same client-owned collections.
The helper also returns `cachedObjects`, which reads the local cache
without acquiring remote demand.

## Select an ontology from a server

Supply one shared client for the server, then select a target by name. Names can
be static aliases such as `connect`, or application-defined keys that include a
saved connection ID.

```tsx
import { OntologyProvider, OntologyEnvironmentProvider } from "@party-stack/ontology-react";
import { workerClient } from "@party-stack/ontology/worker";
import { webRuntime } from "@party-stack/web-runtime";

const client = workerClient(
    () =>
        new SharedWorker(new URL("./ontology.worker.ts", import.meta.url), {
            type: "module",
            name: "app",
        })
);
const options = { runtime: webRuntime({ storage: "memory" }) };

<OntologyEnvironmentProvider client={client} {...options}>
    <Suspense fallback={<p>Opening…</p>}>
        <OntologyProvider ontology={selectedOntology}>
            <Issues />
        </OntologyProvider>
    </Suspense>
</OntologyEnvironmentProvider>;
```

A named `OntologyProvider` can override defaults with direct props, such as
`label="Issues"` or `demand={issueDemand}`. Nested groups such as `cache` and
`writes` are replaced as a group. Keep object-valued inputs stable between renders.

Changing the selected name closes the previous tab view. The server owns its
persistent replicas independently. For HTTP, use
`httpClient("/api/ontology/rpc")` instead. The environment opens the client once
and closes it on unmount; selected views borrow its transport.

Use `useOntology<AppOntology>()` for actions, attachments and offline pins. The
provider supplies TanStack DB's `DbProvider`; collection descriptors need no
client argument. Authentication uses ordinary actions on the `connect` ontology;
there is no installation-specific React context or account subscription protocol.

## Authentication

`AuthenticationProvider` specializes the ordinary ontology provider for Connect. It owns
its query view and the Promise command client, borrowing the environment's shared
transport and runtime. Acquisition suspends; unmount closes both resources.

```tsx
import { AuthenticationProvider, useAuthentication } from "@party-stack/ontology-react/authentication";

<OntologyEnvironmentProvider client={client} {...options}>
    <Suspense fallback={<p>Loading accounts…</p>}>
        <AuthenticationProvider>
            <AccountSwitcher />
        </AuthenticationProvider>
    </Suspense>
</OntologyEnvironmentProvider>;

function SignInButton() {
    const authentication = useAuthentication();
    async function signIn() {
        await authentication
            .oauth({ applicationId: "app", redirectUrl })
            .signIn({ browserPresentation: "popup" });
    }
    return <button onClick={signIn}>Sign in</button>;
}
```

`authenticationObjects`, exported from `@party-stack/ontology/authentication`,
contains typed collection descriptors for `OAuthConnection`, `ApiKeyConnection`,
`ExternalSessionConnection`, and service/application configuration. Use them with
`useLiveSuspenseQuery` inside `AuthenticationProvider` to build a reactive profile
switcher. Selection belongs to the app; commands come from `useAuthentication()`.
`signOut(account)` retains an inactive account; `forget(account)` removes its saved
row. Both accept `{ kind: "oauth" | "api-key" | "external-session", id }`, also
returned by sign-in and one-shot inventory commands. Application replicas and
queued actions remain until explicitly removed.
The descriptors resolve against this view. Authentication commands run
directly against Connect's ordinary backend actions; they never enter the local
replica outbox. Sign-in starts from the event handler, not provider construction.

## Component fragments and files

Fragment definitions and hooks are re-exported from `@party-stack/db-fragments`.
Import root query hooks directly from `@tanstack/react-db` and configure retention
through its native query options. A fragment's `.include` uses a native `include`;
`useFragment(ref)` returns `{ data }`, where `data` is the selected row or `undefined` if it no longer exists. Plural
fragments use `defineListFragment` and `useListFragment`. The parent query owns
membership and lifetime. See the Notes app for nested editor/folder/attachment
fragments, or [the fragment package](../db-fragments/README.md) for a small example.
Arguments are inferred from defaults such as `(row, { includeBody = false })`.
Use a parameter annotation such as `(row, args: Args)` for required arguments or
constrained types, and bind them with `fragment.include(row, args)`.

```tsx
import { useAttachmentMetadata, useAttachmentUrl } from "@party-stack/ontology-react";
import { Suspense } from "react";
import type { attachment } from "@party-stack/ontology/values";

function AttachmentImage({ file }: { file: attachment }) {
    const url = useAttachmentUrl(file);
    const metadata = useAttachmentMetadata(file, { select: ["name", "size"] });
    return <img src={url} alt={metadata?.name ?? "Attachment"} />;
}

<Suspense fallback={<span>Loading image…</span>}>
    <AttachmentImage file={file} />
</Suspense>;
```

Both attachment hooks suspend initially and throw failures to the nearest error
boundary. They accept `enabled: false`, returning an undefined value without
starting a read. Matching requests share stable Promises within the provider.
Settled reads are collected after five inactive minutes, revoking their object
URLs. Pending reads remain owned by the provider even without a committed reader.
Closing the provider aborts pending reads and revokes all its cached URLs. This
request lifetime is separate from the replica's stored attachment bytes.

```tsx
const { status, set, clear } = useOfflinePin();
```

Pins use ordinary TanStack DB queries: bind a named descriptor with
`ontology.pins(downloadFolder)`, query its typed `.collection`, and call `.set(inputs)`
or `.remove(inputs)` directly. Joins on `pin.inputs.folderId` can add download
status to a folder list. No dedicated React pin hook is needed.

Attachment hooks return the URL or selected metadata directly. Loading suspends and
failures reach the error boundary; disabled or absent attachments return `undefined`.
