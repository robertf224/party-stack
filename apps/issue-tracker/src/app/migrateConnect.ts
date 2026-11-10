import { runtimeCredentialValues, makeConnectStore } from "@party-stack/connect";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { FOUNDRY_CLIENT_ID, FOUNDRY_INSTALLATION_ID, FOUNDRY_URL } from "./trackerConfig";
import type { ConnectStore, ConnectCredentialValues } from "@party-stack/connect";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { Runtimes } from "@party-stack/runtime";

/** One-time import from the former per-installation owners; application cache
 * partitions retain their existing names. No refresh token is sent to a tab.
 */
export const migrateTrackerConnections = Effect.fn("Tracker.migrateConnections")(function* (options: {
    runtimes: Runtimes["Service"];
    store: ConnectStore;
    values: ConnectCredentialValues;
    tables: TablesService;
}) {
    const marker = Table.make<boolean>({ name: "connect-migrations" });
    if (yield* options.tables.get(marker, "service-connections")) return;
    const foundry = yield* options.runtimes.acquire({
        owner: "installation",
        namespace: encodeURIComponent(FOUNDRY_INSTALLATION_ID),
    });
    const issuer = `${FOUNDRY_URL.replace(/\/$/, "")}/multipass/`;
    const namespace = JSON.stringify([
        "connect",
        foundry.owner,
        foundry.namespace,
        issuer,
        FOUNDRY_CLIENT_ID,
    ]);
    const oldValues = yield* runtimeCredentialValues(foundry, namespace);
    const previous = yield* makeConnectStore({ tables: foundry.tables, namespace });
    while (true) {
        const rows = yield* previous.load("OAuthConnection", { limit: 100 });
        for (const row of rows) {
            if (!(yield* options.store.get("OAuthConnection", row.id))) {
                const copy = { ...row, application: FOUNDRY_CLIENT_ID };
                for (const property of ["accessToken", "refreshToken"] as const) {
                    const handle = row[property];
                    if (handle)
                        copy[property] = yield* oldValues
                            .decrypt(Schema.String, handle)
                            .pipe(Effect.flatMap((value) => options.values.encrypt(Schema.String, value)));
                }
                yield* options.store.put("OAuthConnection", copy);
            }
            yield* previous.delete("OAuthConnection", row.id);
        }
        if (rows.length < 100) break;
    }
    const sqlite = yield* options.runtimes.acquire({
        owner: "installation",
        namespace: "issue-tracker-sqlite",
    });
    const selectors = Table.make<{ id: string; userId: string; expiresAt: number }>({
        name: JSON.stringify(["better-auth", "issue-tracker-sqlite", "session-selectors"]),
    });
    while (true) {
        const rows = yield* sqlite.tables.query(selectors, { limit: 100 });
        for (const { key, value } of rows) {
            const id = JSON.stringify(["sqlite", value.id]);
            if (!(yield* options.store.get("ExternalSessionConnection", id)))
                yield* options.store.put("ExternalSessionConnection", {
                    id,
                    title: value.userId,
                    serviceInstance: "sqlite",
                    userId: value.userId,
                    sessionId: value.id,
                    status: value.expiresAt > Date.now() ? "active" : "needs-auth",
                    expiresAt: Temporal.Instant.fromEpochMilliseconds(value.expiresAt),
                });
            yield* sqlite.tables.delete(selectors, key);
        }
        if (rows.length < 100) break;
    }
    yield* options.tables.put(marker, "service-connections", true);
});
