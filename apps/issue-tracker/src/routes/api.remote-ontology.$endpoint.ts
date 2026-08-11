import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { createFileRoute } from "@tanstack/react-router";
import { createRemoteOntologyServer } from "@party-stack/remote-ontology/server";
import {
    createSQLiteOntologyBackendAdapter,
    type CreateSQLiteOntologyBackendAdapterOptions,
} from "@party-stack/sqlite-ontology";
import ontology from "../ontology/ontology";
import type { IssueTrackerOntology } from "../ontology/generated/types";

mkdirSync("temp", { recursive: true });

const remoteServer = createRemoteOntologyServer<
    Record<string, never>,
    IssueTrackerOntology
>({
    ir: ontology,
    backendAdapter: createSQLiteOntologyBackendAdapter({
        ir: ontology,
        database: new Database(
            "temp/issue-tracker.sqlite"
        ) as unknown as CreateSQLiteOntologyBackendAdapterOptions["database"],
        name: "issue-tracker-sqlite",
    }),
    getContext: () => ({}),
    policy: {
        baseObjectTypeQueries: {
            Issue: ({ q, collection }) =>
                q.from({ object: collection }),
            Project: ({ q, collection }) =>
                q.from({ object: collection }),
        },
        allowedObjectTypeProperties: {
            Issue: [
                "issueCompletedAt",
                "issueStatus",
                "issueUpdatedAt",
                "issueId",
                "issueTitle",
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
        },
        canApplyAction: () => true,
    },
});

export const Route = createFileRoute("/api/remote-ontology/$endpoint")({
    server: {
        handlers: {
            POST: ({ request }) => remoteServer.handleRequest(request),
            GET: ({ request }) => remoteServer.handleRequest(request),
        },
    },
});
