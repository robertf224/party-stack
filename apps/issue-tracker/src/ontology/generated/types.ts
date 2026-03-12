// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

export type Task = {
    id: string;
    location: v.geopoint;
    createdBy: string;
    title: string;
    completedAt: v.timestamp;
};
export type IssueTrackerOntology = {
    objectTypes: {
        Task: Task;
    };
};
