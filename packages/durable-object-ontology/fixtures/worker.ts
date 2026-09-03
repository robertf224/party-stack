import { DurableObject } from "cloudflare:workers";
import { createLiveOntology } from "@party-stack/ontology";
import { sqliteOntologyConformanceIR } from "@party-stack/sqlite-ontology/testing";
import { queryOnce } from "@tanstack/db";
import { createDurableObjectOntologyBackendAdapter } from "../src/index.js";

interface FixtureEnvironment {
    BLOBS: R2Bucket;
    CELLS: DurableObjectNamespace<OntologyFixture>;
}

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status });
}

export class OntologyFixture extends DurableObject<FixtureEnvironment> {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const segments = url.pathname.split("/").filter(Boolean);
        const ontologyId = request.headers.get("x-party-stack-fixture-ontology");
        if (ontologyId !== "primary" && ontologyId !== "secondary") {
            return json({ error: "Missing ontology routing context." }, 400);
        }
        const ontology = await createLiveOntology({
            ir: sqliteOntologyConformanceIR,
            context: {
                user: request.headers.get("x-user-id") ?? "local-user",
            },
            backend: () =>
                createDurableObjectOntologyBackendAdapter({
                    ir: sqliteOntologyConformanceIR,
                    storage: this.ctx.storage,
                    bucket: this.env.BLOBS,
                    installationId: this.ctx.id.toString(),
                    ontologyId,
                }),
        });
        try {
            if (segments[0] === "notes" && request.method === "POST") {
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
            if (segments[0] === "notes" && (request.method === "GET" || request.method === "POST")) {
                await queryOnce((query) =>
                    query
                        .from({
                            note: ontology.objects.Note!,
                        })
                        .select(({ note }) => note)
                );
                return json({
                    ontologyId,
                    notes: [...ontology.objects.Note!.values()].map((note) => ({
                        id: note.id,
                        title: note.title,
                        owner: note.owner,
                    })),
                });
            }
            return json({ error: "Unknown route." }, 404);
        } finally {
            await ontology.cleanup();
        }
    }
}

const worker: ExportedHandler<FixtureEnvironment> = {
    fetch(request, environment) {
        const url = new URL(request.url);
        const segments = url.pathname.split("/").filter(Boolean);
        const ontologyId = segments[3];
        if (
            segments[0] !== "cells" ||
            !segments[1] ||
            segments[2] !== "ontologies" ||
            (ontologyId !== "primary" && ontologyId !== "secondary")
        ) {
            return Promise.resolve(
                json({
                    usage: "/cells/{cell}/ontologies/{primary|secondary}/notes",
                })
            );
        }
        const stub = environment.CELLS.get(
            environment.CELLS.idFromName(JSON.stringify([segments[1], ontologyId]))
        );
        const forwarded = new URL(request.url);
        forwarded.pathname = `/${segments.slice(4).join("/")}`;
        const forwardedRequest = new Request(forwarded, request);
        forwardedRequest.headers.set("x-party-stack-fixture-ontology", ontologyId);
        return stub.fetch(forwardedRequest);
    },
};

export default worker;
