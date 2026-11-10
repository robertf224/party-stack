/** Keep this harness tab alive until the browser context closes. */
export async function installSqliteHost(context, base) {
    const hostPage = await context.newPage();
    await hostPage.goto(new URL("/favicon.svg", base).href);
    const configuration = await hostPage.evaluate(async (trace) => {
        const { openSqliteBenchmarkHost } = await import("/e2e/sqlite-host.ts");
        const owner = await openSqliteBenchmarkHost({ trace });
        globalThis.sqliteBenchmarkHost = owner;
        return { readyMs: owner.readyMs, workerUrl: owner.workerUrl, workerName: owner.workerName };
    }, process.env.PARTY_SQLITE_TRACE === "1");
    await context.addInitScript(({ workerUrl, workerName }) => {
        const NativeSharedWorker = globalThis.SharedWorker;
        globalThis.SharedWorker = new Proxy(NativeSharedWorker, {
            construct(target, input) {
                const args = [...input];
                const path = new URL(String(args[0]), location.href).pathname;
                if (path.endsWith("/ontology.worker.ts") || path.endsWith("/sqlite-ontology.worker.ts")) {
                    args[0] = workerUrl;
                    args[1] = {
                        ...(typeof args[1] === "object" ? args[1] : {}),
                        type: "module",
                        name: workerName,
                    };
                }
                return Reflect.construct(target, args);
            },
        });
    }, configuration);
    return configuration;
}
