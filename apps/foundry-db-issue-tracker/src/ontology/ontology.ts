// Auto-generated file - do not edit manually

import { o } from "@party-stack/ontology";
import type { OntologyIR } from "@party-stack/ontology";
export default {
    types: [],
    objectTypes: [
        {
            name: "StreamlineForm",
            displayName: "[Streamline] Form",
            pluralDisplayName: "Forms",
            primaryKey: "id",
            properties: [
                {
                    name: "liveRevisionId",
                    displayName: "Live revision id",
                    type: o.string({}),
                },
                {
                    name: "id",
                    displayName: "Id",
                    type: o.string({}),
                },
                {
                    name: "isPublicSubmissionAllowed",
                    displayName: "Is public submission allowed",
                    type: o.boolean({}),
                },
                {
                    name: "updatedAt",
                    displayName: "Updated at",
                    type: o.timestamp({}),
                },
                {
                    name: "observabilityEnabled",
                    displayName: "Observability Enabled",
                    type: o.boolean({}),
                },
                {
                    name: "actionTypeRid",
                    displayName: "Action type RID",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "createdAt",
                    displayName: "Created at",
                    type: o.timestamp({}),
                },
                {
                    name: "allowedImageSources",
                    displayName: "Allowed image sources",
                    type: o.list({
                        elementType: o.string({}),
                    }),
                },
                {
                    name: "spec",
                    displayName: "Spec",
                    type: o.string({}),
                },
                {
                    name: "theme",
                    displayName: "Theme",
                    type: o.string({}),
                },
                {
                    name: "publicSecurityPoliciesEnabled",
                    displayName: "Public security policies enabled",
                    type: o.boolean({}),
                },
                {
                    name: "media",
                    displayName: "Media",
                    type: o.list({
                        elementType: o.attachment({}),
                    }),
                },
            ],
        },
        {
            name: "StreamlineFormRevision",
            displayName: "[Streamline] Form revision",
            pluralDisplayName: "Form revisions",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "Id",
                    type: o.string({}),
                },
                {
                    name: "formId",
                    displayName: "Form id",
                    type: o.string({}),
                },
                {
                    name: "theme",
                    displayName: "Theme",
                    type: o.string({}),
                },
                {
                    name: "spec",
                    displayName: "Spec",
                    type: o.string({}),
                },
                {
                    name: "createdBy",
                    displayName: "Created by",
                    type: o.string({}),
                },
                {
                    name: "actionTypeRid",
                    displayName: "Action type RID",
                    type: o.string({}),
                },
                {
                    name: "media",
                    displayName: "Media",
                    type: o.list({
                        elementType: o.attachment({}),
                    }),
                },
                {
                    name: "createdAt",
                    displayName: "Created at",
                    type: o.timestamp({}),
                },
                {
                    name: "allowedImageSources",
                    displayName: "Allowed image sources",
                    type: o.list({
                        elementType: o.string({}),
                    }),
                },
            ],
        },
    ],
    linkTypes: [
        {
            id: "ri.ontology.main.relation.22d2c930-1c51-430f-a72d-af50c68bc548",
            source: {
                objectType: "StreamlineFormRevision",
                name: "liveRevision",
                displayName: "Live revision",
            },
            target: {
                objectType: "StreamlineForm",
                name: "liveRevisionForm",
                displayName: "Form",
            },
            foreignKey: "liveRevisionId",
            cardinality: "one",
        },
        {
            id: "ri.ontology.main.relation.7f47a026-9cc2-457f-9895-5291cb254d3f",
            source: {
                objectType: "StreamlineForm",
                name: "form",
                displayName: "Form",
            },
            target: {
                objectType: "StreamlineFormRevision",
                name: "formRevisions",
                displayName: "Form revision",
            },
            foreignKey: "formId",
            cardinality: "one",
        },
    ],
} satisfies OntologyIR;
