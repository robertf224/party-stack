import { defineOntology, o } from "@party-stack/ontology-spec";

const input = (name: string) => o.Expression.inputReference({ name });

export const ir = defineOntology({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Todo",
            displayName: "Todo",
            pluralDisplayName: "Todos",
            primaryKey: "id",
            title: "title",
            icon: { name: "check" },
            color: "#a99bf7",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "done", displayName: "Done", type: o.boolean({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "createTodo",
            displayName: "Create todo",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}), defaultValue: o.Expression.uuid({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Todo",
                    values: [
                        { property: ["id"], value: input("id") },
                        { property: ["title"], value: input("title") },
                        { property: ["done"], value: o.Expression.literal({ value: false }) },
                    ],
                }),
            ],
        },
        {
            name: "setDone",
            displayName: "Set done",
            parameters: [
                { name: "todo", displayName: "Todo", type: o.objectReference({ objectType: "Todo" }) },
                { name: "done", displayName: "Done", type: o.boolean({}) },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "todo" },
                    values: [{ property: ["done"], value: input("done") }],
                }),
            ],
        },
        {
            name: "deleteTodo",
            displayName: "Delete todo",
            parameters: [
                { name: "todo", displayName: "Todo", type: o.objectReference({ objectType: "Todo" }) },
            ],
            logic: [o.ActionLogicStep.deleteObject({ object: { name: "todo" } })],
        },
    ],
});
