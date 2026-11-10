import { use, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** A synchronous value still needs a committed owner before descendants can
 * start reads. Publishing it directly avoids introducing a Suspense Promise.
 * Abandoned renders allocate nothing; StrictMode's immediate effect replay
 * reuses the value, while a real unmount disposes it in the next microtask.
 */
export function OwnedValue<Resource extends { cleanup(): void | Promise<void> }>({
    open,
    children,
}: {
    readonly open: () => Resource;
    readonly children: (resource: Resource) => ReactNode;
}) {
    type Lease = {
        readonly open: typeof open;
        readonly value: Resource;
        active: boolean;
        disposed: boolean;
    };
    const owner = useRef<Lease | undefined>(undefined);
    const [state, setState] = useState<Lease>();
    useEffect(() => {
        if (!owner.current || owner.current.open !== open || owner.current.disposed)
            owner.current = { open, value: open(), active: true, disposed: false };
        const lease = owner.current;
        lease.active = true;
        setState(lease);
        return () => {
            lease.active = false;
            queueMicrotask(() => {
                if (lease.active || lease.disposed) return;
                lease.disposed = true;
                if (owner.current === lease) owner.current = undefined;
                void Promise.resolve()
                    .then(() => lease.value.cleanup())
                    .catch((error: unknown) => console.error("Failed to close owned value.", error));
            });
        };
    }, [open]);
    if (!state || state.open !== open || state.disposed) return null;
    return children(state.value);
}

/** The first empty commit installs the owner before reading its Promise can
 * suspend. A component-local lease survives StrictMode's immediate effect replay;
 * a real unmount closes it in the next microtask, including late acquisitions.
 * No render starts IO and no global resource cache retains abandoned Scopes.
 */
export function OwnedResource<Resource extends { cleanup(): Promise<void> }>({
    open,
    children,
}: {
    readonly open: () => Promise<Resource>;
    readonly children: (resource: Resource) => ReactNode;
}) {
    return (
        <OwnedResourceLease open={open}>
            {(promise) => <ResolvedProvider promise={promise}>{children}</ResolvedProvider>}
        </OwnedResourceLease>
    );
}

/** Publish the owned acquisition before it resolves so dependent openings can
 * compose their Promises without serial Suspense reveals. The lease, including
 * late completion cleanup, still belongs to this committed component.
 */
export function OwnedResourceLease<Resource extends { cleanup(): Promise<void> }>({
    open,
    children,
}: {
    readonly open: () => Promise<Resource>;
    readonly children: (promise: Promise<Resource>) => ReactNode;
}) {
    type Lease = {
        readonly open: typeof open;
        readonly promise: ReturnType<typeof open>;
        active: boolean;
        disposed: boolean;
        acquired?: Resource;
    };
    const owner = useRef<Lease | undefined>(undefined);
    const [state, setState] = useState<Lease>();
    const [failure, setFailure] = useState<{ lease: Lease; cause: unknown }>();
    useEffect(() => {
        const close = (ontology: Resource) => {
            void ontology
                .cleanup()
                .catch((error: unknown) => console.error("Failed to close ontology resource.", error));
        };
        if (!owner.current || owner.current.open !== open || owner.current.disposed) {
            const lease: Lease = {
                open,
                active: true,
                disposed: false,
                promise: Promise.resolve()
                    .then(open)
                    .then((ontology) => {
                        if (lease.disposed) close(ontology);
                        else lease.acquired = ontology;
                        return ontology;
                    }),
            };
            // The owner reports failures even when no child consumes its lease.
            // Late failures after disposal remain observed without updating React.
            void lease.promise.catch((cause: unknown) => {
                if (lease.active && !lease.disposed) setFailure({ lease, cause });
            });
            owner.current = lease;
        }
        const lease = owner.current;
        lease.active = true;
        queueMicrotask(() => {
            if (lease.active && !lease.disposed) setState(lease);
        });
        return () => {
            lease.active = false;
            queueMicrotask(() => {
                if (lease.active || lease.disposed) return;
                lease.disposed = true;
                if (lease.acquired) close(lease.acquired);
                if (owner.current === lease) owner.current = undefined;
            });
        };
    }, [open]);
    if (!state || state.open !== open) return null;
    if (failure?.lease === state) throw failure.cause;
    return children(state.promise);
}
function ResolvedProvider<Resource>({
    promise,
    children,
}: {
    readonly promise: Promise<Resource>;
    readonly children: (resource: Resource) => ReactNode;
}) {
    return children(use(promise));
}
