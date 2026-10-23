import { makeStorageOntologyBackend, type OntologyBackendAdapter } from "@party-stack/ontology";
import { createRemoteOntologyServer } from "@party-stack/ontology-server/server";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import ontology from "../ontology/ontology";
import { auth } from "../server/auth";
import { serverOntology } from "../server/ontology";
import { publicBackend } from "../server/public-backend";
import { serverStorage } from "../server/storage";
import type { IssueTrackerOntology } from "../ontology/generated/types";

const backendAdapter: OntologyBackendAdapter = {
    name: "issue-tracker-sqlite",
    open: (context) =>
        makeStorageOntologyBackend({
            ir: serverOntology,
            namespace: serverStorage.namespace,
            context,
            ...serverStorage.native,
        }).pipe(Effect.map((backend) => publicBackend(backend, ontology))),
};

const contexts = new WeakMap<Request, { user: string }>();

const remoteServer = createRemoteOntologyServer<{ user: string }, IssueTrackerOntology>({
    ir: ontology,
    backendAdapter,
    getContext: (request) => {
        const context = contexts.get(request);
        if (!context) {
            throw new Error("Authenticated request context is unavailable.");
        }
        return context;
    },
    policy: {
        // This demo shares the public schema only. The backend projects both rows and
        // journal changes before this permission can grant full-view replication.
        authorizeFullReplica: () => true,
        visibleActionTypes: ontology.actionTypes.map((action) => action.name),
        baseObjectTypeQueries: {
            Issue: ({ q, collection }) => q.from({ object: collection }),
            Project: ({ q, collection }) => q.from({ object: collection }),
            User: ({ q, collection }) => q.from({ object: collection }),
        },
        allowedObjectTypeProperties: {
            Issue: [
                "issueCompletedAt",
                "issueStatus",
                "issueUpdatedAt",
                "issueId",
                "issueLabels",
                "createdBy",
                "issueTitle",
                "assignee",
                "issueAttachments",
                "projectId",
                "issueCreatedAt",
                "issueDescription",
            ],
            Project: [
                "projectUpdatedAt",
                "projectDescription",
                "projectColor",
                "projectId",
                "projectCreatedAt",
                "projectTitle",
            ],
            User: ["id", "givenName", "familyName", "email", "avatar"],
        },
        clientContext: "forward",
        canApplyAction: (_context, request) =>
            ontology.actionTypes.some((action) => action.name === request.actionType),
    },
});

async function handleRequest(request: Request): Promise<Response> {
    const selected = await auth.api.getSession({
        headers: request.headers,
    });
    if (!selected) {
        return new Response("Authentication required.", {
            status: 401,
            headers: {
                "www-authenticate": 'Session realm="Party Stack Issue Tracker"',
            },
        });
    }
    contexts.set(request, {
        user: selected.user.id,
    });
    return remoteServer.handleRequest(request);
}

export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => handleRequest(request),
            GET: ({ request }) => handleRequest(request),
        },
    },
});
