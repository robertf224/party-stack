// Auto-generated file - do not edit manually

import * as v from "@party-stack/ontology/values";

/** A tracked unit of work that can optionally belong to a project and progress through a simple status lifecycle. */
export type Issue = {
    /** Timestamp when the issue entered the Completed state; empty while the issue is not completed. */
    issueCompletedAt: v.timestamp;
    /** Current workflow state of the issue: Open, In Progress, Waiting, or Completed. */
    issueStatus: string;
    /** Timestamp of the most recent update made to the issue. */
    issueUpdatedAt: v.timestamp;
    /** Stable system-generated identifier for an issue. */
    issueId: string;
    /** Short, human-readable summary used to identify the issue in lists and workflows. */
    issueTitle: string;
    /** Files that provide supporting material or evidence for the issue. */
    issueAttachments: Array<v.attachment<"image/png" | "image/jpeg">>;
    /** Identifier of the optional project that groups this issue. */
    projectId: string;
    /** Timestamp when the issue was created through the operational workflow. */
    issueCreatedAt: v.timestamp;
    /** Detailed context, requirements, or notes explaining the work represented by the issue. */
    issueDescription: string;
};

/** A collection of related issues organized around a shared objective or body of work. */
export type Project = {
    /** Timestamp of the most recent update made to the project. */
    projectUpdatedAt: v.timestamp;
    /** Summary of the project's purpose, scope, or intended outcome. */
    projectDescription: string;
    /** Display color used to visually distinguish the project, stored as a hexadecimal color value such as #2D72D2. */
    projectColor: string;
    /** Stable system-generated identifier for a project. */
    projectId: string;
    /** Timestamp when the project was created through the operational workflow. */
    projectCreatedAt: v.timestamp;
    /** Short, human-readable name used to identify the project. */
    projectTitle: string;
};

export type CreateIssueParameters = {
    completedAt?: v.timestamp | null;
    attachments?: Array<v.attachment<"image/png" | "image/jpeg">> | null;
    project?: string | null;
    description?: string | null;
    title: string;
    status: "Open" | "In Progress" | "Waiting" | "Completed";
    "__uuid_0df17cad-fc40-4f4b-b755-dfccb968d615"?: string;
    __now?: v.timestamp;
};
export type CreateProjectParameters = {
    color?: string | null;
    description?: string | null;
    title: string;
    "__uuid_7af1b7e1-9b8f-470d-bcf1-e02376d353c1"?: string;
    __now?: v.timestamp;
};
export type DeleteIssueParameters = {
    issue: string;
};
export type DeleteProjectParameters = {
    project: string;
};
export type UpdateIssueParameters = {
    completedAt?: v.timestamp | null;
    attachments?: Array<v.attachment<"image/png" | "image/jpeg">> | null;
    issue: string;
    description?: string | null;
    project?: string | null;
    title: string;
    status: "Open" | "In Progress" | "Waiting" | "Completed";
    __now?: v.timestamp;
};
export type UpdateProjectParameters = {
    color?: string | null;
    project: string;
    description?: string | null;
    title: string;
    __now?: v.timestamp;
};
export type IssueTrackerOntology = {
    objectTypes: {
        Issue: Issue;
        Project: Project;
    };
    actionTypes: {
        createIssue: {
            parameters: CreateIssueParameters;
        };
        createProject: {
            parameters: CreateProjectParameters;
        };
        deleteIssue: {
            parameters: DeleteIssueParameters;
        };
        deleteProject: {
            parameters: DeleteProjectParameters;
        };
        updateIssue: {
            parameters: UpdateIssueParameters;
        };
        updateProject: {
            parameters: UpdateProjectParameters;
        };
    };
    queryFunctionTypes: Record<never, never>;
};
