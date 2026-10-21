import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRemoteOntologyServer } from "@party-stack/ontology-server/server";
import {
    createSQLiteOntologyBackendAdapter,
    type CreateSQLiteOntologyBackendAdapterOptions,
} from "@party-stack/sqlite-ontology";
import { eq } from "@tanstack/db";
import { createFileRoute } from "@tanstack/react-router";
import Database from "better-sqlite3";
import { Effect } from "effect";
import ontology from "../ontology/ontology";
import { auth, issueTrackerUsers } from "../server/auth";
import type { IssueTrackerOntology } from "../ontology/generated/types";
import type { OntologyIR } from "@party-stack/ontology";

mkdirSync("temp", { recursive: true });

const database = new Database("temp/issue-tracker.sqlite");
const seedAction = "_seedAuthenticatedUser";
const serverIR: OntologyIR = {
    ...ontology,
    actionTypes: [
        ...ontology.actionTypes,
        {
            name: seedAction,
            displayName: "Update authenticated profile",
            logic: [],
            parameters: ontology.objectTypes.find((object) => object.name === "User")!.properties,
        },
    ],
};
const backendAdapter = createSQLiteOntologyBackendAdapter({
    ir: serverIR,
    mutators: {
        [seedAction]: async ({ tx, args, context }) => {
            if (args.id !== context.user)
                throw new Error("Profile identity does not match the authenticated user.");
            const existing = await tx.query<Record<string, unknown> | undefined>((q, objects) =>
                q
                    .from({ user: objects.User! })
                    .where(({ user }) => eq(user.id, args.id))
                    .findOne()
            );
            if (existing) await tx.mutate.User!.update(args.id as string, args);
            else await tx.mutate.User!.create(args);
        },
    },
    database: database as unknown as CreateSQLiteOntologyBackendAdapterOptions["database"],
    name: "issue-tracker-sqlite-users",
});

const contexts = new WeakMap<Request, { user: string }>();

const remoteServer = createRemoteOntologyServer<{ user: string }, IssueTrackerOntology>({
    ir: serverIR,
    backendAdapter,
    getContext: (request) => {
        const context = contexts.get(request);
        if (!context) {
            throw new Error("Authenticated request context is unavailable.");
        }
        return context;
    },
    policy: {
        // This demo is a shared workspace: every authenticated user can read every row/property.
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
        canApplyAction: (_context, request) => String(request.actionType) !== seedAction,
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
    const profile = {
        id: selected.user.id,
        givenName: seeded?.givenName ?? givenName ?? selected.user.name,
        familyName: seeded?.familyName ?? familyName.join(" "),
        email: selected.user.email,
    };
    await Effect.runPromise(
        Effect.scoped(
            Effect.flatMap(backendAdapter.open({ user: selected.user.id }), (backend) =>
                backend.invoke({
                    name: seedAction,
                    parameters: profile,
                    id: `profile:${seedAction}:${createHash("sha256").update(JSON.stringify(profile)).digest("hex")}`,
                })
            )
        )
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
