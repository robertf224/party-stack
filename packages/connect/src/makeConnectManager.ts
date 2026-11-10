import { BackendError } from "@party-stack/ontology-backend";
import { Runtime } from "@party-stack/runtime";
import { Context, Effect, Layer } from "effect";
import { makeConnectBackend, connectBackendError } from "./core/backend.js";
import { runtimeCredentialValues } from "./oauth/storage.js";
import { makeServiceConnections } from "./serviceConnections.js";
import type { ConnectActionHandler } from "./core/backend.js";
import type { ServiceConnector } from "./ServiceConnector.js";
import type { OAuthApplicationRecord, ServiceInstanceRecord } from "./spec/index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

/** A device/server credential owner. Runtime supplies Tables and key storage;
 * service integrations supply authentication/egress, and the ontology stores inventory.
 * Expose backend through a policy-bound ordinary ontology server.
 */
export interface ConnectOAuthApplicationConfiguration extends Omit<
    OAuthApplicationRecord,
    "serviceInstance" | "id" | "title" | "flow"
> {
    readonly id?: string;
    readonly title?: string;
    readonly flow?: OAuthApplicationRecord["flow"];
}
export interface ConnectInstanceConfiguration extends Omit<
    ServiceInstanceRecord,
    "service" | "id" | "title"
> {
    readonly id?: string;
    readonly title?: string;
    readonly OAuthApplications?: readonly ConnectOAuthApplicationConfiguration[];
}
export interface ConnectServiceConfiguration {
    readonly connector: ServiceConnector;
    readonly instances?: readonly ConnectInstanceConfiguration[];
}
export interface ConnectManagerOptions {
    readonly ir?: OntologyIR;
    readonly actionHandlers?: Readonly<Record<string, ConnectActionHandler>>;
    readonly namespace?: string;
    readonly services: readonly ConnectServiceConfiguration[];
    /** Start the scoped periodic sweep. Alarms/jobs call maintenance.run themselves. */
    readonly startMaintenance?: boolean;
    readonly maintenance?: { readonly intervalMs?: number };
}
export const makeConnectManager = Effect.fn("ConnectManager.make")(function* (
    options: ConnectManagerOptions
) {
    const runtime = yield* Runtime;
    const namespace = options.namespace ?? runtime.namespace;
    const values = yield* runtimeCredentialValues(runtime, namespace).pipe(
        Effect.mapError(connectBackendError)
    );
    const instances: ServiceInstanceRecord[] = [];
    const applications: OAuthApplicationRecord[] = [];
    for (const configured of options.services) {
        const { connector } = configured;
        for (const { OAuthApplications, ...instance } of configured.instances ?? []) {
            const canonicalUrl = yield* Effect.try({
                try: () => new URL(instance.instanceUrl).href.replace(/\/+$/, ""),
                catch: () =>
                    new BackendError({
                        operation: "connect.configure",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message: "A service instance must have an absolute URL.",
                    }),
            });
            const id = instance.id ?? JSON.stringify([connector.service, canonicalUrl]);
            const title = instance.title ?? connector.displayName ?? connector.service;
            instances.push({ ...instance, id, title, service: connector.service });
            for (const application of OAuthApplications ?? []) {
                const scopes = application.scopes ?? connector.defaultOAuthScopes;
                applications.push({
                    ...application,
                    id: application.id ?? JSON.stringify([id, application.clientId]),
                    title: application.title ?? title,
                    flow: application.flow ?? "authorization-code",
                    scopes: scopes === undefined ? undefined : [...scopes],
                    serviceInstance: id,
                });
            }
        }
    }
    if (
        new Set(instances.map((row) => row.id)).size !== instances.length ||
        new Set(applications.map((row) => row.id)).size !== applications.length
    )
        return yield* new BackendError({
            operation: "connect.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Service instance and OAuth application IDs must be unique.",
        });
    const authority = yield* makeConnectBackend({
        ir: options.ir,
        actionHandlers: options.actionHandlers,
        tables: runtime.tables,
        namespace,
        values,
        services: options.services.map((entry) => entry.connector),
        maintenance: options.startMaintenance === false ? false : options.maintenance,
    });
    yield* authority.store
        .transaction(
            Effect.gen(function* () {
                for (const instance of instances) yield* authority.store.put("ServiceInstance", instance);
                for (const application of applications) {
                    const previous = yield* authority.store.get("OAuthApplication", application.id);
                    yield* authority.store.put("OAuthApplication", { ...previous, ...application });
                }
            })
        )
        .pipe(Effect.mapError(connectBackendError));
    yield* authority.connect.collectExpired().pipe(Effect.mapError(connectBackendError));
    const connections = yield* makeServiceConnections({
        backend: authority.backend,
        store: authority.store,
        services: options.services.map((entry) => entry.connector),
    });
    return { ...authority, values, connections, maintenance: { run: authority.backend.maintenance! } };
});

export type ConnectManagerService = Effect.Success<ReturnType<typeof makeConnectManager>>;
export class ConnectManager extends Context.Service<ConnectManager, ConnectManagerService>()(
    "@party-stack/connect/ConnectManager"
) {
    static readonly layer = (options: ConnectManagerOptions) =>
        Layer.effect(ConnectManager, makeConnectManager(options));
}
