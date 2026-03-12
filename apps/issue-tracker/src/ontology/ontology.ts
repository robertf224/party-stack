// Auto-generated file - do not edit manually

import { o } from "@party-stack/ontology";
import type { OntologyIR } from "@party-stack/ontology";
export default {
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "Id",
                    type: o.string({}),
                },
                {
                    name: "location",
                    displayName: "Location",
                    type: o.geopoint({}),
                },
                {
                    name: "createdBy",
                    displayName: "Created by",
                    type: o.string({}),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "completedAt",
                    displayName: "Completed at",
                    type: o.timestamp({}),
                },
            ],
        },
    ],
    linkTypes: [],
} satisfies OntologyIR;
