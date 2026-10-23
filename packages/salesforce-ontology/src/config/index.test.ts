import { o, type OntologyIR } from "@party-stack/ontology";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceOntologyPullConfig, createSalesforceOntologyPullSource } from "./index.js";
import type { Connection } from "@party-stack/connect";

function createSource() {
    return createSalesforceOntologyPullSource({
        instanceUrl: "https://example.my.salesforce.com",
        apiVersion: "65.0",
        ontologyId: "salesforce:tasks",
        objectTypeNames: ["Task", "User"],
        connection: {
            oauth: {
                clientId: "client",
                redirectUrl: "http://localhost:1717/oauth/callback",
            },
        },
    });
}

describe("createSalesforceOntologyPullSource", () => {
    it("reuses the only restored active connection", async () => {
        const connection: Connection<"active"> = {
            userId: "005000000000001",
            state: { status: "active" },
        };
        const oauth = vi.fn();

        const resolved = await createSource().resolveConnection({
            connections: new Map([[connection.userId, connection]]),
            authentication: {
                signIn: {
                    oauth,
                },
            },
        } as never);

        expect(resolved).toEqual(connection);
        expect(oauth).not.toHaveBeenCalled();
    });

    it("starts OAuth when no connection is restored", async () => {
        const connection: Connection<"active"> = {
            userId: "005000000000001",
            state: { status: "active" },
        };
        const oauth = vi.fn(() => Promise.resolve(connection));

        const resolved = await createSource().resolveConnection({
            connections: new Map(),
            authentication: {
                signIn: {
                    oauth,
                },
            },
        } as never);

        expect(resolved).toEqual(connection);
        expect(oauth).toHaveBeenCalledOnce();
    });

    it("builds a pull config with a scoped metadata allowlist", () => {
        const config = createSalesforceOntologyPullConfig({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "65.0",
            ontologyId: "salesforce:tasks",
            objectTypeNames: ["Task", "User"],
            flowActionTypeNames: ["Create_Task"],
            standardActionTypeNames: ["confirmSalesMeeting"],
            standardQueryFunctionTypeNames: ["getAvailableMeetingTimes"],
            crudActionTypes: [
                {
                    objectType: "Task",
                    operations: ["create", "update", "delete"],
                },
            ],
            connection: {
                token: "token",
                userId: "005000000000001",
            },
        });

        expect(config.source.ontologyId).toBe("salesforce:tasks");
        expect(config.objectTypeNames).toEqual(["Task", "User"]);
        expect(config.actionTypeNames).toEqual([
            "Create_Task",
            "confirmSalesMeeting",
            "createTask",
            "updateTask",
            "deleteTask",
        ]);
        expect(config.queryFunctionTypeNames).toEqual(["getAvailableMeetingTimes"]);
    });

    it("requires CRUD object types to be pulled", () => {
        expect(() =>
            createSalesforceOntologyPullConfig({
                instanceUrl: "https://example.my.salesforce.com",
                apiVersion: "65.0",
                ontologyId: "salesforce:tasks",
                objectTypeNames: ["User"],
                flowActionTypeNames: [],
                crudActionTypes: [
                    {
                        objectType: "Task",
                        operations: ["create"],
                    },
                ],
                connection: { token: "token" },
            })
        ).toThrow(/must also appear in objectTypeNames/);
    });

    it("keeps selected object references and downgrades dangling references", async () => {
        const ontology: OntologyIR = {
            types: [],
            objectTypes: [
                {
                    name: "Task",
                    displayName: "Task",
                    pluralDisplayName: "Tasks",
                    primaryKey: "Id",
                    properties: [
                        {
                            name: "Id",
                            displayName: "ID",
                            type: o.string({}),
                        },
                        {
                            name: "CreatedById",
                            displayName: "Created By",
                            type: o.objectReference({
                                objectType: "User",
                            }),
                        },
                        {
                            name: "AccountId",
                            displayName: "Account",
                            type: o.optional({
                                type: o.objectReference({
                                    objectType: "Account",
                                }),
                            }),
                        },
                    ],
                },
                {
                    name: "User",
                    displayName: "User",
                    pluralDisplayName: "Users",
                    primaryKey: "Id",
                    properties: [
                        {
                            name: "Id",
                            displayName: "ID",
                            type: o.string({}),
                        },
                    ],
                },
            ],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        };

        const transformed = await createSource().transformPulledOntology!(ontology);
        const task = transformed.objectTypes.find((objectType) => objectType.name === "Task")!;

        expect(task.properties.find((property) => property.name === "CreatedById")?.type).toEqual(
            o.objectReference({
                objectType: "User",
            })
        );
        expect(task.properties.find((property) => property.name === "AccountId")?.type).toEqual(
            o.optional({
                type: o.string({}),
            })
        );
    });
});
