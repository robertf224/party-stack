import { describe, expect, it } from "vite-plus/test";
import { synthesizeSalesforceCrudActionTypes } from "./synthesizeCrudActionTypes.js";

describe("synthesizeSalesforceCrudActionTypes", () => {
    it("derives supported CRUD actions and writable fields from describe", () => {
        const actions = synthesizeSalesforceCrudActionTypes({
            name: "Task",
            label: "Task",
            createable: true,
            updateable: true,
            deletable: true,
            fields: [
                {
                    name: "Id",
                    label: "Task ID",
                    type: "id",
                    nillable: false,
                    createable: false,
                    updateable: false,
                },
                {
                    name: "Subject",
                    label: "Subject",
                    type: "string",
                    nillable: false,
                    createable: true,
                    updateable: true,
                },
                {
                    name: "Status",
                    label: "Status",
                    type: "picklist",
                    nillable: false,
                    createable: true,
                    updateable: true,
                    defaultedOnCreate: true,
                    picklistValues: [],
                },
                {
                    name: "CreatedDate",
                    label: "Created Date",
                    type: "datetime",
                    nillable: false,
                    createable: false,
                    updateable: false,
                    calculated: true,
                },
            ],
        } as never);

        expect(actions.map((action) => action.name)).toEqual(["createTask", "updateTask", "deleteTask"]);
        expect(actions[0]).toMatchObject({
            id: "salesforce:crud:create:Task",
            meta: { salesforce: { kind: "crud", objectType: "Task", operation: "create" } },
            parameters: [{ name: "Subject" }, { name: "Status", type: { kind: "optional" } }],
            logic: [
                {
                    kind: "createObject",
                    value: {
                        objectType: "Task",
                        values: [
                            {
                                property: ["Subject"],
                                value: { kind: "inputReference", value: { name: "Subject" } },
                            },
                            {
                                property: ["Status"],
                                value: { kind: "inputReference", value: { name: "Status" } },
                            },
                        ],
                    },
                },
            ],
        });
        expect(actions[1]).toMatchObject({
            id: "salesforce:crud:update:Task",
            meta: { salesforce: { kind: "crud", objectType: "Task", operation: "update" } },
            parameters: [
                { name: "recordId" },
                { name: "Subject", type: { kind: "optional" } },
                { name: "Status", type: { kind: "optional" } },
            ],
            logic: [{ kind: "updateObject", value: { object: { name: "recordId" } } }],
        });
        expect(actions[2]).toMatchObject({
            id: "salesforce:crud:delete:Task",
            meta: { salesforce: { kind: "crud", objectType: "Task", operation: "delete" } },
            parameters: [{ name: "recordId" }],
            logic: [{ kind: "deleteObject", value: { object: { name: "recordId" } } }],
        });
    });
});
