// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

export type Task = {
    createdAt: v.timestamp;
    completedAt: v.timestamp;
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
    location?: string;
    title: string;
    "__uuid_9131b78a-d4a1-443b-9fca-a3f70c2355ef"?: string;
    __now?: v.timestamp;
};

export type DeleteTaskParameters = {
    task: string;
};

export type ReopenTaskParameters = {
    completedAt?: v.timestamp;
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
};
