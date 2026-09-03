// Auto-generated file - do not edit manually

import * as v from "@party-stack/ontology/values";

export type Task = {
    Id: string;
    Subject?: string;
    ActivityDate?: v.date;
    Status: "Not Started" | "In Progress" | "Completed" | "Waiting on someone else" | "Deferred";
    Priority: "High" | "Normal" | "Low";
    OwnerId: string;
    Description?: string;
    IsClosed: boolean;
    CreatedDate: v.timestamp;
    CreatedById: string;
    LastModifiedDate: v.timestamp;
    LastModifiedById: string;
};

export type User = {
    Id: string;
    Username: string;
    Name: string;
    Email: string;
};

export type SalesforceTaskManagerOntologyContext = Record<string, unknown>;
export type CreateTaskParameters = {
    subject: string;
    status: "Not Started" | "In Progress" | "Completed" | "Waiting on someone else" | "Deferred";
    priority: "High" | "Normal" | "Low";
    activityDate?: v.date | null;
};
export type UpdateTaskParameters = {
    task: string;
    subject: string;
    status: "Not Started" | "In Progress" | "Completed" | "Waiting on someone else" | "Deferred";
    priority: "High" | "Normal" | "Low";
    activityDate?: v.date | null;
};
export type DeleteTaskParameters = {
    task: string;
};
export type SalesforceTaskManagerOntology = {
    context: SalesforceTaskManagerOntologyContext;
    objectTypes: {
        Task: Task;
        User: User;
    };
    actionTypes: {
        createTask: {
            parameters: CreateTaskParameters;
        };
        updateTask: {
            parameters: UpdateTaskParameters;
        };
        deleteTask: {
            parameters: DeleteTaskParameters;
        };
    };
    queryFunctionTypes: Record<never, never>;
};
