/** Stable in-flight reads belong to a view, including renders which never commit.
 * Settled reads stay reusable for five inactive minutes; expiry releases their
 * object URLs. Pending reads are cancelled when the view owner closes.
 */
export class AttachmentPromiseCache {
    private readonly entries = new Map<string, Entry<unknown>>();
    private disposed = false;

    constructor(private readonly inactiveTime = 5 * 60_000) {}

    get<A>(key: string, open: (signal: AbortSignal) => Promise<A>, close?: (value: A) => void): Entry<A> {
        if (this.disposed) throw new Error("The attachment view has closed.");
        const found = this.entries.get(key);
        if (found) return found as Entry<A>;
        const controller = new AbortController();
        const entry: Entry<A> = {
            key,
            controller,
            listeners: new Set(),
            settled: false,
            disposed: false,
            hasValue: false,
            close,
            promise: Promise.resolve()
                .then(() => {
                    if (controller.signal.aborted)
                        throw new DOMException("The attachment view has closed.", "AbortError");
                    return open(controller.signal);
                })
                .then(
                    (value) => {
                        entry.settled = true;
                        if (entry.disposed) {
                            close?.(value);
                            throw new DOMException("The attachment view has closed.", "AbortError");
                        }
                        entry.value = value;
                        entry.hasValue = true;
                        this.collectLater(key, entry);
                        return value;
                    },
                    (error: unknown) => {
                        entry.settled = true;
                        this.collectLater(key, entry);
                        throw error;
                    }
                ),
        };
        // A failed read may no longer have a Suspense reader after navigation.
        void entry.promise.catch(() => {});
        this.entries.set(key, entry as Entry<unknown>);
        return entry;
    }

    subscribe<A>(entry: Entry<A>, listener: () => void) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.listeners.add(listener);
        return () => {
            entry.listeners.delete(listener);
            this.collectLater(entry.key, entry);
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const entry of this.entries.values()) this.release(entry);
        this.entries.clear();
    }

    private collectLater<A>(key: string, entry: Entry<A>) {
        if (!entry.settled || entry.disposed || entry.listeners.size || entry.timer !== undefined) return;
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (entry.listeners.size || entry.disposed) return;
            if (this.entries.get(key) === entry) this.entries.delete(key);
            this.release(entry);
        }, this.inactiveTime);
    }

    private release<A>(entry: Entry<A>) {
        if (entry.disposed) return;
        entry.disposed = true;
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.controller.abort();
        if (entry.hasValue) entry.close?.(entry.value!);
    }
}

export type Entry<A> = {
    readonly key: string;
    readonly controller: AbortController;
    readonly promise: Promise<A>;
    readonly listeners: Set<() => void>;
    readonly close?: (value: A) => void;
    settled: boolean;
    disposed: boolean;
    hasValue: boolean;
    value?: A;
    timer?: ReturnType<typeof setTimeout>;
};
