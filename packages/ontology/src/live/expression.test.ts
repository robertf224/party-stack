import {
    BasicIndex,
    createCollection,
    localOnlyCollectionOptions,
} from "@tanstack/db";
import { describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { evaluateExpression } from "./expression.js";
import { createReadTx } from "./mutators/createMutatorTx.js";
import type { Expression, OntologyIR } from "../ir/index.js";
import type { OntologyObject } from "./objects/OntologyObject.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "id",
            properties: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                },
                {
                    name: "name",
                    displayName: "Name",
                    type: o.string({}),
                },
            ],
        },
    ],
    actionTypes: [
        {
            name: "assign",
            displayName: "Assign",
            parameters: [
                {
                    name: "user",
                    displayName: "User",
                    type: o.objectReference({
                        objectType: "User",
                    }),
                },
            ],
            logic: [],
        },
    ],
};

describe("evaluateExpression", () => {
    it("resolves object-reference paths through the read transaction", async () => {
        const users = createCollection(
            localOnlyCollectionOptions<
                OntologyObject,
                string | number
            >({
                id: "expression-users",
                defaultIndexType: BasicIndex,
                getKey: (user) =>
                    user.id as string | number,
                initialData: [
                    {
                        id: "user-1",
                        name: "Ada",
                    },
                    {
                        id: "user-2",
                        name: "Grace",
                    },
                ],
            })
        );
        users.createIndex((user) => user.id);
        await users.preload();

        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: {
                    kind: "valueReference",
                    value: {
                        path: ["user", "name"],
                    },
                } as Expression,
                resolveParameter: () =>
                    Promise.resolve("user-1"),
                context: {},
                tx: createReadTx({ User: users }),
            })
        ).resolves.toBe("Ada");

        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: o.Expression.objectQuery({
                    objectType: "User",
                    where: o.ObjectQueryPredicate.eq({
                        property: ["name"],
                        value: "Ada",
                    }),
                }),
                resolveParameter: () =>
                    Promise.resolve(undefined),
                context: {},
                tx: createReadTx({ User: users }),
            })
        ).resolves.toBe("user-1");

        await expect(
            evaluateExpression({
                ir,
                actionTypeName: "assign",
                expression: o.Expression.objectQuery({
                    objectType: "User",
                }),
                resolveParameter: () =>
                    Promise.resolve(undefined),
                context: {},
                tx: createReadTx({ User: users }),
            })
        ).resolves.toBeUndefined();
        await users.cleanup();
    });
});
