import { createConnectionManager, createConnectionMonitor } from "@party-stack/connections";
import { createLocalCollection } from "@party-stack/runtime";
import type { Connection } from "@party-stack/connections";
import { createLiveOntology } from "../live/LiveOntology.js";
import type {
    CreateOntologyBackendInstallationOptions,
    OntologyBackendInstallation,
    OntologyRoute,
} from "./types.js";
import type { LiveOntology } from "../live/LiveOntology.js";
import type { OntologyDefinition } from "../live/LiveOntology.js";
import type { MetaOntology } from "../meta/generated/types.js";

interface LocalOntologyPartition {
    id: string;
    userId: string;
    ontologyId: string;
}

function scope(value: string): string {
    return encodeURIComponent(value);
}

function ontologyKey(userId: string, ontologyId: string): string {
    return `${scope(userId)}:${scope(ontologyId)}`;
}

function metaOntologyKey(userId: string, ontologyId: string): string {
    return `${ontologyKey(userId, ontologyId)}:meta`;
}

function liveOntologyNamespace(installationId: string, ontologyId: string): string {
    return `${scope(installationId)}:${scope(ontologyId)}`;
}

function isActiveConnection(connection: Connection | undefined): connection is Connection<"active"> {
    return connection?.state.status === "active";
}

function routeFor(routes: readonly OntologyRoute[], ontologyId: string): OntologyRoute {
    const matching = routes.filter((route) => route.matches(ontologyId));
    if (matching.length !== 1) {
        throw new Error(
            matching.length === 0
                ? `No ontology route matched "${ontologyId}".`
                : `Multiple ontology routes matched "${ontologyId}".`
        );
    }
    return matching[0]!;
}

export async function createOntologyBackendInstallation<AuthenticationClient extends object = object>(
    options: CreateOntologyBackendInstallationOptions<AuthenticationClient>
): Promise<OntologyBackendInstallation<AuthenticationClient>> {
    const installationRuntime = await options.runtime("installation", scope(options.installationId));
    let connectionManager;
    try {
        connectionManager = await createConnectionManager({
            installationId: options.installationId,
            runtime: installationRuntime,
            adapter: options.connections,
        });
    } catch (error) {
        await installationRuntime.cleanup?.();
        throw error;
    }
    const partitions = createLocalCollection<LocalOntologyPartition, string>({
        name: "ontology-partitions",
        getKey: (partition) => partition.id,
        runtime: installationRuntime,
        schemaVersion: 1,
    });
    try {
        await partitions.preload();
    } catch (error) {
        await partitions.cleanup();
        await connectionManager.cleanup();
        await installationRuntime.cleanup?.();
        throw error;
    }
    const live = new Map<string, LiveOntology>();
    const opening = new Map<string, Promise<LiveOntology>>();
    let disposed = false;
    let cleanupPromise: Promise<void> | undefined;

    const closeKey = async (key: string) => {
        const pending = opening.get(key);
        if (pending) {
            await pending.catch(() => undefined);
        }
        const ontology = live.get(key);
        if (!ontology) return;
        live.delete(key);
        await ontology.cleanup();
    };
    const close = (userId: string, ontologyId: string) => closeKey(ontologyKey(userId, ontologyId));
    const recordPartition = async (partition: LocalOntologyPartition): Promise<void> => {
        const existing = partitions.get(partition.id);
        const transaction = existing
            ? partitions.update(
                  partition.id,
                  {
                      optimistic: false,
                  },
                  (draft) => {
                      Object.assign(draft, partition);
                  }
              )
            : partitions.insert(partition, {
                  optimistic: false,
              });
        await transaction.isPersisted.promise;
    };
    const removePartitionRecord = async (id: string): Promise<void> => {
        if (!partitions.get(id)) {
            return;
        }
        const transaction = partitions.delete(id, {
            optimistic: false,
        });
        await transaction.isPersisted.promise;
    };
    const destroyPartition = async (partition: LocalOntologyPartition): Promise<void> => {
        const pending = opening.get(partition.id);
        if (pending) {
            await pending.catch(() => undefined);
        }
        const ontology = live.get(partition.id);
        live.delete(partition.id);
        if (ontology) {
            await ontology.destroy();
        } else {
            const runtime = await options.runtime(
                partition.userId,
                liveOntologyNamespace(options.installationId, partition.ontologyId)
            );
            if (runtime.destroy) {
                await runtime.destroy();
            } else {
                await runtime.cleanup?.();
            }
        }
        await removePartitionRecord(partition.id);
    };
    const destroyUserPartitions = async (userId: string): Promise<void> => {
        const prefix = `${scope(userId)}:`;
        await Promise.allSettled(
            [...opening].filter(([key]) => key.startsWith(prefix)).map(([, pending]) => pending)
        );
        await Promise.all(
            [...partitions.values()].filter((partition) => partition.userId === userId).map(destroyPartition)
        );
    };
    const closeUserOntologies = async (userId: string): Promise<void> => {
        const prefix = `${scope(userId)}:`;
        const toClose = [...new Set([...live.keys(), ...opening.keys()])].filter((key) =>
            key.startsWith(prefix)
        );
        await Promise.all(toClose.map(closeKey));
    };
    const openConfiguredOntology = async <Ontology extends OntologyDefinition>(openOptions: {
        userId: string;
        ontologyId: string;
        meta: boolean;
    }): Promise<LiveOntology<Ontology>> => {
        const { userId, ontologyId, meta } = openOptions;
        if (disposed) {
            throw new Error(`Backend installation "${options.installationId}" is closed.`);
        }
        const key = meta ? metaOntologyKey(userId, ontologyId) : ontologyKey(userId, ontologyId);
        const existing = live.get(key);
        if (existing) {
            return existing as unknown as LiveOntology<Ontology>;
        }
        const pending = opening.get(key);
        if (pending) {
            return pending as unknown as Promise<LiveOntology<Ontology>>;
        }
        const open = (async () => {
            const current = connectionManager.connections.get(userId);
            if (!isActiveConnection(current)) {
                throw new Error(
                    `User "${userId}" is not connected to backend installation "${options.installationId}".`
                );
            }
            const egress = connectionManager.egress(userId);
            if (!egress) {
                throw new Error(`Connection egress for user "${userId}" is unavailable.`);
            }
            const route = routeFor(options.routes, ontologyId);
            const configureOptions = {
                connection: current,
                egress,
                ontologyId,
            };
            let configured;
            if (meta) {
                if (!route.configureMeta) {
                    throw new Error(`Ontology route for "${ontologyId}" does not support metadata.`);
                }
                configured = await route.configureMeta(configureOptions);
            } else {
                if (!route.configure) {
                    throw new Error(
                        `Ontology route for "${ontologyId}" does not support opening the application ontology.`
                    );
                }
                configured = await route.configure(configureOptions);
            }
            const context = {
                ...options.createContext?.(userId, ontologyId),
                ...configured.context,
                user: userId,
            };
            const runtimeNamespace = `${liveOntologyNamespace(options.installationId, ontologyId)}${
                meta ? ":meta" : ""
            }`;
            if (!meta) {
                await recordPartition({
                    id: key,
                    userId,
                    ontologyId,
                });
            }
            const ontology = await createLiveOntology({
                id: runtimeNamespace,
                ir: configured.ir,
                backend: configured.backend,
                runtime: options.runtime,
                context,
                persistObjects: configured.persistObjects,
                writes: configured.writes,
                connection: createConnectionMonitor(connectionManager, userId),
            });
            if (disposed) {
                await ontology.cleanup();
                throw new Error(
                    meta
                        ? `Backend installation "${options.installationId}" closed while opening metadata for ontology "${ontologyId}".`
                        : `Backend installation "${options.installationId}" closed while opening ontology "${ontologyId}".`
                );
            }
            live.set(key, ontology);
            return ontology;
        })();
        opening.set(key, open);
        try {
            return (await open) as unknown as LiveOntology<Ontology>;
        } finally {
            if (opening.get(key) === open) {
                opening.delete(key);
            }
        }
    };

    const installation: OntologyBackendInstallation<AuthenticationClient> = {
        installationId: options.installationId,
        get connections() {
            return connectionManager.connections;
        },
        get authentication() {
            return connectionManager.authentication;
        },
        async disconnect(userId) {
            await closeUserOntologies(userId);
            await connectionManager.disconnect(userId);
        },
        async forget(userId) {
            const results = await Promise.allSettled([
                destroyUserPartitions(userId),
                connectionManager.forget(userId),
            ]);
            const errors: unknown[] = [];
            for (const result of results) {
                if (result.status === "rejected") {
                    errors.push(result.reason as unknown);
                }
            }
            if (errors.length > 0) {
                throw new AggregateError(
                    errors,
                    `Failed to forget user "${userId}" from backend installation "${options.installationId}".`
                );
            }
        },
        async openOntology<Ontology extends OntologyDefinition = OntologyDefinition>({
            userId,
            ontologyId,
        }: {
            userId: string;
            ontologyId: string;
        }): Promise<LiveOntology<Ontology>> {
            return openConfiguredOntology<Ontology>({
                userId,
                ontologyId,
                meta: false,
            });
        },
        async openMetaOntology({ userId, ontologyId }) {
            return openConfiguredOntology<MetaOntology>({
                userId,
                ontologyId,
                meta: true,
            });
        },
        closeOntology: ({ userId, ontologyId }) => close(userId, ontologyId),
        closeMetaOntology: ({ userId, ontologyId }) => closeKey(metaOntologyKey(userId, ontologyId)),
        cleanup() {
            cleanupPromise ??= (async () => {
                disposed = true;
                try {
                    await Promise.allSettled(opening.values());
                    await Promise.all([...live.values()].map((ontology) => ontology.cleanup()));
                } finally {
                    live.clear();
                    try {
                        await Promise.all([connectionManager.cleanup(), partitions.cleanup()]);
                    } finally {
                        await installationRuntime.cleanup?.();
                    }
                }
            })();
            return cleanupPromise;
        },
    };
    return installation;
}
