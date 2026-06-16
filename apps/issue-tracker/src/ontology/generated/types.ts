// Auto-generated file - do not edit manually

import * as v from "@party-stack/ontology/values";

export type Task = {
    createdAt: v.timestamp;
    completedAt: v.timestamp;
    attachments: Array<v.attachment>;
    createdBy: string;
    location: v.geopoint;
    id: string;
    title: string;
    completedBy: string;
};

export type CompleteTaskParameters = {
    task: string;
    __now?: v.timestamp;
};
export type CreateTaskParameters = {
    attachments?: Array<v.attachment> | null;
    location?: v.geopoint | null;
    title: string;
    "__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef"?: string;
    __now?: v.timestamp;
};
export type DeleteTaskParameters = {
    task: string;
};
export type ReopenTaskParameters = {
    completedAt?: v.timestamp | null;
    task: string;
};
export type IssueTrackerOntology = {
    objectTypes: {
        Task: Task;
    };
    actionTypes: {
        completeTask: {
            parameters: CompleteTaskParameters;
        };
        createTask: {
            parameters: CreateTaskParameters;
        };
        deleteTask: {
            parameters: DeleteTaskParameters;
        };
        reopenTask: {
            parameters: ReopenTaskParameters;
        };
    };
    queryTypes: Record<never, never>;
};
