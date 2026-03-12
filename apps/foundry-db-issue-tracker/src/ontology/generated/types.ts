// Auto-generated file - do not edit manually

import * as v from "@party-stack/schema/values";

export type StreamlineForm = {
    liveRevisionId: string;
    id: string;
    isPublicSubmissionAllowed: boolean;
    updatedAt: v.timestamp;
    observabilityEnabled: boolean;
    actionTypeRid: string;
    title: string;
    createdAt: v.timestamp;
    allowedImageSources: Array<string>;
    spec: string;
    theme: string;
    publicSecurityPoliciesEnabled: boolean;
    media: Array<v.attachment>;
};

export type StreamlineFormRevision = {
    id: string;
    formId: string;
    theme: string;
    spec: string;
    createdBy: string;
    actionTypeRid: string;
    media: Array<v.attachment>;
    createdAt: v.timestamp;
    allowedImageSources: Array<string>;
};
export type FoundryDbIssueTrackerOntology = {
    objectTypes: {
        StreamlineForm: StreamlineForm;
        StreamlineFormRevision: StreamlineFormRevision;
    };
};
