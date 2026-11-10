/** Experimental harness only: this tab must outlive every measured Notes tab. */
export async function openSqliteBenchmarkHost(options: { readonly trace?: boolean } = {}) {
    const started = performance.now();
    const database = new Worker(new URL("./sqlite-opfs.worker.ts", import.meta.url), { type: "module" });
    const worker = new URL("./sqlite-ontology.worker.ts?worker_file&type=module", import.meta.url);
    if (options.trace) worker.searchParams.set("sqlTrace", "1");
    const workerUrl = worker.href;
    const workerName = "party-notes-sqlite-benchmark";
    const replica = new SharedWorker(workerUrl, { name: workerName, type: "module" });
    const channel = new MessageChannel();
    const cleanup = () => {
        replica.port.close();
        database.terminate();
    };
    try {
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(
                () => reject(new Error("SQLite benchmark host startup timed out.")),
                30_000
            );
            database.onerror = (event) => {
                clearTimeout(deadline);
                reject(new Error(event.message));
            };
            replica.onerror = (event) => {
                clearTimeout(deadline);
                reject(new Error(event.message));
            };
            replica.port.onmessage = (event) => {
                clearTimeout(deadline);
                if (event.data?.kind === "notes-sqlite-ready") resolve();
                else reject(new Error("Unexpected SQL benchmark host response."));
            };
            replica.port.start();
            database.postMessage({ kind: "notes-sqlite-host", port: channel.port1 }, [channel.port1]);
            replica.port.postMessage({ kind: "notes-sqlite-host", port: channel.port2 }, [channel.port2]);
        });
    } catch (error) {
        cleanup();
        throw error;
    }
    return { readyMs: performance.now() - started, workerUrl, workerName, cleanup };
}
