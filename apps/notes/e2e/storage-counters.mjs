/** Test-only counters injected through CDP. Native request results and scheduling are unchanged. */
export function installStorageCounters() {
    globalThis.__partyStorageCounters?.stop();
    const originals = [];
    const transactions = new WeakMap();
    const records = [];
    const now = () => performance.timeOrigin + performance.now();
    const timers = {};
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function (callback, delay, ...args) {
        if (typeof callback !== "function") return originalTimeout(callback, delay, ...args);
        const started = now();
        const timing = (timers[String(delay ?? 0)] ??= {
            issued: 0,
            completed: 0,
            totalMs: 0,
            maxMs: 0,
            below1Ms: 0,
            below3Ms: 0,
            below6Ms: 0,
            below20Ms: 0,
            longer: 0,
        });
        timing.issued++;
        return originalTimeout(
            function (...values) {
                const elapsed = now() - started;
                timing.completed++;
                timing.totalMs += elapsed;
                timing.maxMs = Math.max(timing.maxMs, elapsed);
                timing[
                    elapsed < 1
                        ? "below1Ms"
                        : elapsed < 3
                          ? "below3Ms"
                          : elapsed < 6
                            ? "below6Ms"
                            : elapsed < 20
                              ? "below20Ms"
                              : "longer"
                ]++;
                return callback.apply(this, values);
            },
            delay,
            ...args
        );
    };
    originals.push(() => {
        globalThis.setTimeout = originalTimeout;
    });
    const record = (transaction) => {
        let entry = transactions.get(transaction);
        if (!entry) {
            entry = { id: records.length, at: now(), mode: transaction.mode, counts: {} };
            transactions.set(transaction, entry);
            records.push(entry);
            transaction.addEventListener("complete", () => {
                entry.completedAt = now();
            });
            transaction.addEventListener("abort", () => {
                entry.abortedAt = now();
            });
        }
        return entry;
    };
    const wrap = (prototype, name, count) => {
        const original = prototype[name];
        originals.push(() => {
            prototype[name] = original;
        });
        prototype[name] = function (...args) {
            const tracking = count.call(this, args);
            const result = original.apply(this, args);
            if (tracking && result instanceof IDBRequest) {
                const { entry, key } = tracking;
                if (tracking.indexRequest) {
                    const requests = (entry.indexRequests ??= []);
                    if (requests.length < 256) {
                        const request = { at: now(), ...tracking.indexRequest, completed: false };
                        requests.push(request);
                        let previousValue;
                        const addValue = (value) => {
                            if (typeof value !== "string") return;
                            const runs = (request.valueRuns ??= []);
                            if (request.valueRunsOverflow) return;
                            if (value === previousValue) runs[runs.length - 1]++;
                            else if (runs.length < 128) runs.push(1);
                            else request.valueRunsOverflow = true;
                            previousValue = value;
                        };
                        result.addEventListener("success", () => {
                            request.completed = true;
                            request.completedAt = now();
                            if (request.operation === "count") request.count = result.result;
                            else if (request.operation === "getAll") {
                                request.rows = result.result.length;
                                request.continuesPreviousValue =
                                    tracking.boundValue !== undefined &&
                                    result.result[0]?.value === tracking.boundValue;
                                for (const entry of result.result) addValue(entry.value);
                            } else if (result.result) {
                                request.rows = (request.rows ?? 0) + 1;
                                addValue(result.result.value?.value);
                            }
                        });
                        result.addEventListener(
                            "error",
                            () => {
                                request.failed = true;
                            },
                            { once: true }
                        );
                    } else entry.indexOverflow = true;
                }
                const timings = (entry.timings ??= {});
                const timing = (timings[key] ??= {
                    issued: 0,
                    completed: 0,
                    active: 0,
                    peak: 0,
                    totalMs: 0,
                    maxMs: 0,
                });
                const started = now();
                timing.issued++;
                timing.peak = Math.max(timing.peak, ++timing.active);
                const done = () => {
                    const elapsed = now() - started;
                    timing.completed++;
                    timing.active--;
                    timing.totalMs += elapsed;
                    timing.maxMs = Math.max(timing.maxMs, elapsed);
                };
                result.addEventListener("success", done, { once: true });
                result.addEventListener("error", done, { once: true });
            }
            return result;
        };
    };
    const tableFor = (argument) => {
        if (argument && typeof argument === "object" && "table" in argument) return argument.table;
        const key = argument instanceof IDBKeyRange ? (argument.lower ?? argument.upper) : argument;
        return Array.isArray(key) ? key[0] : typeof key === "string" ? key : "*";
    };
    for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
        for (const name of [
            "get",
            "getAll",
            "getAllKeys",
            "count",
            "put",
            "add",
            "delete",
            "clear",
            "openCursor",
            "openKeyCursor",
        ]) {
            if (typeof prototype[name] !== "function") continue;
            wrap(prototype, name, function (args) {
                const store = this instanceof IDBIndex ? this.objectStore : this;
                const key = `${tableFor(args[0])}|${store.name}|${this instanceof IDBIndex ? this.name : ""}|${name}`;
                const entry = record(store.transaction);
                entry.counts[key] = (entry.counts[key] ?? 0) + 1;
                const range = args[0] instanceof IDBKeyRange ? args[0] : undefined;
                const lower = range?.lower;
                const upper = range?.upper;
                // Only structural index metadata and numeric result sizes are
                // recorded. Never retain bounds, row keys or record contents.
                const indexRequest =
                    store.name === "entries" &&
                    ["count", "getAll", "openCursor", "openKeyCursor"].includes(name)
                        ? {
                              table: tableFor(args[0]),
                              index:
                                  Array.isArray(lower) && typeof lower[1] === "string"
                                      ? lower[1]
                                      : Array.isArray(upper) && typeof upper[1] === "string"
                                        ? upper[1]
                                        : "*",
                              operation: name,
                              equality:
                                  Array.isArray(lower) &&
                                  Array.isArray(upper) &&
                                  lower.length > 2 &&
                                  upper.length > 2 &&
                                  lower[2] === upper[2],
                              lowerOpen: range?.lowerOpen,
                              upperOpen: range?.upperOpen,
                              limit: typeof args[1] === "number" ? args[1] : undefined,
                              direction: typeof args[1] === "string" ? args[1] : undefined,
                          }
                        : undefined;
                const bound = args[1] === "prev" ? upper : lower;
                const boundValue =
                    Array.isArray(bound) && typeof bound[3] === "string" ? bound[2] : undefined;
                return { entry, key, indexRequest, boundValue };
            });
        }
    }
    for (const name of ["continue", "continuePrimaryKey", "advance"]) {
        wrap(IDBCursor.prototype, name, function () {
            const source = this.source;
            const store = source instanceof IDBIndex ? source.objectStore : source;
            const entry = record(store.transaction);
            const key = `${tableFor(this.primaryKey)}|${store.name}|${source instanceof IDBIndex ? source.name : ""}|cursor.${name}`;
            entry.counts[key] = (entry.counts[key] ?? 0) + 1;
        });
    }
    globalThis.__partyStorageCounters = {
        records,
        timers,
        stop() {
            for (const restore of originals) restore();
            delete globalThis.__partyStorageCounters;
            return records;
        },
    };
    return true;
}

/** Observe the existing provider only; do not open an extra replica or acquire another query. */
export function readTabTraces(mode = "snapshot") {
    if (mode === "stop") {
        const capture = globalThis.partyTraceProbe;
        if (!capture) throw new Error("Test trace capture was not started.");
        capture.stops.forEach((stop) => stop?.());
        delete globalThis.partyTraceProbe;
        return {
            tab: [...capture.tab.values()],
            parent: [...capture.parent.values()],
            overflow: capture.overflow,
        };
    }
    let fiber;
    for (const element of document.querySelectorAll("body *")) {
        const key = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
        if (key) {
            fiber = element[key];
            break;
        }
    }
    if (!fiber) throw new Error("Test inspection could not find the React tree.");
    while (fiber.return) fiber = fiber.return;
    const pending = [fiber];
    while (pending.length) {
        const current = pending.pop();
        const props = current.memoizedProps;
        const ontology = props?.value?.replica
            ? props.value
            : props?.ontology?.replica
              ? props.ontology
              : undefined;
        if (ontology?.traces) {
            if (mode === "start") {
                if (globalThis.partyTraceProbe) throw new Error("Test trace capture already started.");
                const capture = { tab: new Map(), parent: new Map(), stops: [], overflow: false };
                globalThis.partyTraceProbe = capture;
                for (const [store, records] of [
                    [ontology.traces, capture.tab],
                    [ontology.diagnostics?.parent?.traces, capture.parent],
                ]) {
                    if (!store) continue;
                    const seen = new WeakSet();
                    const collect = (record) => {
                        for (const value of record ? [record] : store.getSnapshot()) {
                            if (seen.has(value)) continue;
                            seen.add(value);
                            const { error: _error, ...span } = value;
                            records.set(`${span.traceId}:${span.id}`, span);
                        }
                        while (records.size > 20_000) {
                            capture.overflow = true;
                            records.delete(records.keys().next().value);
                        }
                    };
                    capture.stops.push(store.subscribe(collect));
                    collect();
                }
                return { recording: true };
            }
            return {
                traces: ontology.traces.getSnapshot(),
                status: ontology.diagnostics?.replica.getSnapshot(),
            };
        }
        if (current.sibling) pending.push(current.sibling);
        if (current.child) pending.push(current.child);
    }
    throw new Error("Test inspection could not find the LiveOntology trace store.");
}
