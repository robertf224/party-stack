import { DurableObject } from "cloudflare:workers";
import type { BackendConnectionAdapterProvider, Connection } from "@party-stack/connections";
import { sqliteOntologyConformanceIR } from "@party-stack/sqlite-ontology/testing";
import { queryOnce } from "@tanstack/db";
import {
    createCloudflareSQLiteBackendInstallation,
    createCloudflareSQLiteOntologyRoute,
    type CloudflareSQLiteBackendInstallation,
} from "../src/index.js";

interface FixtureAuthentication {
    connect(userId: string): Promise<Connection<"active">>;
}

interface FixtureEnvironment {
    BLOBS: R2Bucket;
    CELLS: DurableObjectNamespace<OntologyFixtureDurableObject>;
}

const connections: BackendConnectionAdapterProvider<FixtureAuthentication> = () => ({
    name: "fixture",
    createAuthenticationClient: (controller) => ({
        async connect(userId) {
            const connection = {
                userId,
                state: {
                    status: "active" as const,
                },
            };
            await controller.connect({
                connection,
                session: {
                    disconnect: () => Promise.resolve(),
                },
            });
            return connection;
        },
    }),
    restoreConnections: () => Promise.resolve([]),
});

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

export class OntologyFixtureDurableObject extends DurableObject<FixtureEnvironment> {
    private readonly installation: Promise<CloudflareSQLiteBackendInstallation<FixtureAuthentication>>;

    constructor(state: DurableObjectState, environment: FixtureEnvironment) {
        super(state, environment);
        this.installation = state.blockConcurrencyWhile(() =>
            createCloudflareSQLiteBackendInstallation({
                installationId: state.id.toString(),
                storage: state.storage,
                bucket: environment.BLOBS,
                connections,
                routes: ["primary", "secondary"].map((ontologyId) =>
                    createCloudflareSQLiteOntologyRoute({
                        ontologyId,
                        ir: sqliteOntologyConformanceIR,
                    })
                ),
            })
        );
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "DELETE" && url.pathname === "/") {
            const installation = await this.installation;
            await installation.destroyInstallation();
            return json({ destroyed: true });
        }

        const segments = url.pathname.split("/").filter(Boolean);
        const ontologyId = segments[1];
        if (segments[0] !== "ontologies" || (ontologyId !== "primary" && ontologyId !== "secondary")) {
            return json(
                {
                    error: "Use /ontologies/{primary|secondary}/notes.",
                },
                404
            );
        }
        const installation = await this.installation;
        const userId = request.headers.get("x-user-id") ?? "local-user";
        if (installation.connections.get(userId)?.state.status !== "active") {
            await installation.authentication.connect(userId);
        }
        const ontology = await installation.openOntology({
            userId,
            ontologyId,
        });
        if (segments[2] === "notes" && request.method === "POST") {
            const body = (await request.json()) as {
                id?: unknown;
                title?: unknown;
            };
            if (typeof body.id !== "string" || typeof body.title !== "string") {
                return json(
                    {
                        error: "id and title must be strings.",
                    },
                    400
                );
            }
            await ontology.actions.createNote!({
                id: body.id,
                title: body.title,
            });
        }
        if (segments[2] === "notes" && (request.method === "GET" || request.method === "POST")) {
            await queryOnce((query) =>
                query
                    .from({
                        note: ontology.objects.Note!,
                    })
                    .select(({ note }) => note)
            );
            return json({
                ontologyId,
                userId,
                notes: [...ontology.objects.Note!.values()].map((note) => ({
                    id: note.id,
                    title: note.title,
                    owner: note.owner,
                })),
            });
        }
        if (segments[2] === "attachments" && request.method === "POST") {
            const objectId = url.searchParams.get("objectId") ?? crypto.randomUUID();
            const created = await ontology.attachments.create(await request.blob(), {
                target: {
                    kind: "objectProperty",
                    objectType: "Asset",
                    property: "attachment",
                },
            });
            await ontology.actions.createAsset!({
                id: objectId,
                attachment: created.attachment,
            });
            return json({
                objectId,
                attachment: created.attachment,
            });
        }
        if (segments[2] === "attachments" && segments[3] && request.method === "GET") {
            const blob = await ontology.attachments.blob({
                id: segments[3],
            });
            return new Response(blob, {
                headers: {
                    "content-type": blob.type || "application/octet-stream",
                },
            });
        }
        return json({ error: "Unknown route." }, 404);
    }
}

const worker: ExportedHandler<FixtureEnvironment> = {
    fetch(request, environment) {
        const url = new URL(request.url);
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments[0] !== "cells" || !segments[1]) {
            return Promise.resolve(
                json({
                    usage: "/cells/{cell}/ontologies/{primary|secondary}/notes",
                })
            );
        }
        const stub = environment.CELLS.get(environment.CELLS.idFromName(segments[1]));
        const forwarded = new URL(request.url);
        forwarded.pathname = `/${segments.slice(2).join("/")}`;
        return stub.fetch(new Request(forwarded, request));
    },
};

export default worker;
