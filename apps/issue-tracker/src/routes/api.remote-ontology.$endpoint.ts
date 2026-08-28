import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "@tanstack/db";
import { o } from "@party-stack/ontology";
import { createRemoteOntologyServer } from "@party-stack/remote-ontology/server";
import {
    createSQLiteOntologyBackendAdapter,
    type CreateSQLiteOntologyBackendAdapterOptions,
} from "@party-stack/sqlite-ontology";
import ontology from "../ontology/ontology";
import type { IssueTrackerOntology } from "../ontology/generated/types";
import { auth, issueTrackerUsers } from "../server/auth";

mkdirSync("temp", { recursive: true });

const database = new Database("temp/issue-tracker.sqlite");
const backendAdapter = createSQLiteOntologyBackendAdapter({
    ir: ontology,
    database: database as unknown as CreateSQLiteOntologyBackendAdapterOptions["database"],
    name: "issue-tracker-sqlite-users",
});

const seedUser = database.prepare(`
    INSERT INTO "party_stack_issue_x2d_tracker_x2d_sqlite_x2d_users_User" ("id", "data")
    VALUES (?, ?)
    ON CONFLICT("id") DO UPDATE SET "data" = excluded."data"
`);
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
        fixedActionParameterValues: {
            createIssue: {
                createdBy: o.Expression.contextReference({
                    path: ["user"],
                }),
            },
        },
        clientContext: "forward",
        canApplyAction: () => true,
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
    const seeded = issueTrackerUsers.find((user) => user.email === selected.user.email);
    const [givenName, ...familyName] = selected.user.name.split(" ");
    seedUser.run(
        selected.user.id,
        JSON.stringify({
            id: selected.user.id,
            givenName: seeded?.givenName ?? givenName ?? selected.user.name,
            familyName: seeded?.familyName ?? familyName.join(" "),
            email: selected.user.email,
        })
    );
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
