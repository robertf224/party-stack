import { o, type OntologyIR } from "@party-stack/ontology";
import { Runtimes, MemoryRuntime } from "@party-stack/runtime";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSalesforceOntologyPullConfig, makeSalesforcePullBackend } from "./index.js";
const mocks = vi.hoisted(() => ({ manager: vi.fn(), metadata: vi.fn(), acquire: vi.fn() }));
vi.mock("@party-stack/connect", async (original) => ({
    ...(await original<typeof import("@party-stack/connect")>()),
    makeConnectManager: mocks.manager,
    acquireConfiguredConnection: mocks.acquire,
}));
vi.mock("../connect.js", () => ({ makeSalesforceMetadataBackend: mocks.metadata }));
const open = () =>
    Effect.runPromise(
        Effect.scoped(createBackend()).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
    );

function createBackend() {
    return makeSalesforcePullBackend({
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

describe("makeSalesforcePullBackend", () => {
    it("opens metadata through the current manager's scoped acquisition path", async () => {
        const manager = { backend: "current-connect-backend" };
        const egress = { fetch: vi.fn(), createWebSocket: vi.fn() };
        mocks.manager.mockReturnValue(Effect.succeed(manager));
        mocks.acquire.mockReturnValue(Effect.succeed({ egress }));
        mocks.metadata.mockReturnValue(Effect.succeed({ name: "metadata" }));
        expect(await open()).toMatchObject({ name: "metadata" });
        expect(mocks.manager).toHaveBeenCalledWith({
            services: [
                {
                    connector: expect.objectContaining({ service: "salesforce" }),
                    instances: [
                        expect.objectContaining({
                            id: "https://example.my.salesforce.com",
                            OAuthApplications: [
                                expect.objectContaining({ id: "client", flow: "authorization-code" }),
                            ],
                        }),
                    ],
                },
            ],
        });
        expect(mocks.acquire).toHaveBeenCalledWith(
            expect.objectContaining({
                manager,
                serviceInstanceId: "https://example.my.salesforce.com",
                oauth: { applicationId: "client", redirectUrl: "http://localhost:1717/oauth/callback" },
            })
        );
        expect(mocks.metadata).toHaveBeenCalledWith(
            expect.objectContaining({
                egress,
                objectTypeNames: ["Task", "User"],
                instanceUrl: "https://example.my.salesforce.com",
            })
        );
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

        expect(Effect.isEffect(config.backend)).toBe(true);
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

        const config = createSalesforceOntologyPullConfig({
            instanceUrl: "https://example.my.salesforce.com",
            apiVersion: "65.0",
            ontologyId: "salesforce:tasks",
            objectTypeNames: ["Task", "User"],
            flowActionTypeNames: [],
            connection: { token: "token" },
        });
        const transformed = await config.transformPulledOntology!(ontology);
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
