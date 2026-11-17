type Task = (...args: unknown[]) => void;
export interface TimeSlicedImmediateOptions {
    /** Continuous microtask work allowed before deferring to the host event loop. */
    readonly budgetMs?: number;
    readonly now?: () => number;
    readonly queueMicrotask?: (task: () => void) => void;
    readonly setTimeout?: (task: () => void, delay: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
}

/** React Native implements `setImmediate` with microtasks. Effect's scheduler
 * yields through `setImmediate`, so long-running Effect work never returns to
 * the event loop: timers, React's scheduler and native events starve for
 * seconds. Run immediates as microtasks within a short slice, then defer the
 * next one to a timer so the host can render and handle input in between.
 */
export function makeTimeSlicedImmediate(options: TimeSlicedImmediateOptions = {}) {
    const budget = options.budgetMs ?? 8;
    const now = options.now ?? (() => performance.now());
    const microtask = options.queueMicrotask ?? ((task) => globalThis.queueMicrotask(task));
    const timeout = options.setTimeout ?? ((task, delay) => globalThis.setTimeout(task, delay));
    const clear = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number));
    let sliceStart: number | undefined;
    let ids = 0;
    const pending = new Map<number, { cancel: () => void }>();
    const setImmediate = (task: Task, ...args: unknown[]): number => {
        const id = ++ids;
        const run = () => {
            if (!pending.delete(id)) return;
            task(...args);
        };
        const current = now();
        if (sliceStart === undefined) {
            sliceStart = current;
            // Any turn of the event loop ends the slice.
            timeout(() => {
                sliceStart = undefined;
            }, 0);
        }
        if (current - sliceStart < budget) {
            pending.set(id, { cancel: () => {} });
            microtask(run);
        } else {
            const handle = timeout(run, 0);
            pending.set(id, { cancel: () => clear(handle) });
        }
        return id;
    };
    const clearImmediate = (id: number | undefined) => {
        if (id === undefined) return;
        pending.get(id)?.cancel();
        pending.delete(id);
    };
    return { setImmediate, clearImmediate };
}
