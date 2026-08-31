import { createNodeRuntime } from "@party-stack/node-runtime";
import {
    createSalesforceBackendInstallation,
    createSalesforceClient,
    createSalesforceOntologyBackendAdapter,
} from "@party-stack/salesforce-ontology";
import { inArray, queryOnce } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import type {
    ApplyActionLiveOpts,
    OntologyBackendAdapter,
    TypeDef,
} from "@party-stack/ontology";
import type {
    ObjectCollectionUtils,
    SalesforceChangeEvent,
    SalesforceClient,
} from "@party-stack/salesforce-ontology";
import ontology from "./ontology/ontology.js";
import {
    getSalesforceSettings,
    SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
} from "./settings.js";
import type {
    SalesforceTaskManagerOntology,
    Task,
} from "./ontology/generated/types.js";
import type { Collection } from "@tanstack/db";

interface TaskInput {
    subject: string;
    status: Task["Status"];
    priority: Task["Priority"];
    activityDate?: string;
}

type TaskCollection = Collection<
    Record<string, unknown>,
    string | number,
    ObjectCollectionUtils
>;

function taskCollection(
    live: ApplyActionLiveOpts
): TaskCollection {
    const collection = live.objects.Task;
    if (!collection) {
        throw new Error(
            "Task collection is unavailable."
        );
    }
    return collection as TaskCollection;
}

function requireString(
    value: unknown,
    name: string
): string {
    if (
        typeof value !== "string" ||
        value.length === 0
    ) {
        throw new Error(
            `Task action parameter "${name}" is required.`
        );
    }
    return value;
}

function salesforceDate(
    value: unknown
): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    const serialized =
        typeof value === "string"
            ? value
            : value instanceof Temporal.PlainDate
              ? value.toString()
              : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serialized)) {
        throw new Error(
            "Task activityDate must be a date."
        );
    }
    return serialized;
}

function assertSaveSucceeded(result: {
    success: boolean;
    errors: Array<{ message: string }>;
}): void {
    if (result.success) return;
    throw new Error(
        result.errors
            .map((error) => error.message)
            .join("; ") ||
            "Salesforce rejected the Task write."
    );
}

export function createTaskManagerBackend(
    client: SalesforceClient
): OntologyBackendAdapter {
    const base =
        createSalesforceOntologyBackendAdapter({
            client,
            ir: ontology,
        });
    return {
        ...base,
        async applyAction(name, parameters, live) {
            switch (name) {
                case "createTask": {
                    const result =
                        await client.createRecord(
                            "Task",
                            {
                                Subject: requireString(
                                    parameters.subject,
                                    "subject"
                                ),
                                Status: requireString(
                                    parameters.status,
                                    "status"
                                ),
                                Priority: requireString(
                                    parameters.priority,
                                    "priority"
                                ),
                                ActivityDate:
                                    salesforceDate(
                                        parameters.activityDate
                                    ),
                            }
                        );
                    assertSaveSucceeded(result);
                    taskCollection(
                        live
                    ).utils.invalidate();
                    return;
                }
                case "updateTask": {
                    const id = requireString(
                        parameters.task,
                        "task"
                    );
                    const result =
                        await client.updateRecord(
                            "Task",
                            id,
                            {
                                Subject: requireString(
                                    parameters.subject,
                                    "subject"
                                ),
                                Status: requireString(
                                    parameters.status,
                                    "status"
                                ),
                                Priority: requireString(
                                    parameters.priority,
                                    "priority"
                                ),
                                ActivityDate:
                                    salesforceDate(
                                        parameters.activityDate
                                    ),
                            }
                        );
                    assertSaveSucceeded(result);
                    taskCollection(
                        live
                    ).utils.invalidate();
                    return;
                }
                case "deleteTask": {
                    const id = requireString(
                        parameters.task,
                        "task"
                    );
                    const result =
                        await client.deleteRecord(
                            "Task",
                            id
                        );
                    assertSaveSucceeded(result);
                    await taskCollection(
                        live
                    ).utils.deleteByKey(id);
                    return;
                }
                default:
                    return base.applyAction(
                        name,
                        parameters,
                        live
                    );
            }
        },
    };
}

function dateString(
    value: unknown
): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    if (
        value instanceof Temporal.PlainDate ||
        value instanceof Temporal.Instant ||
        value instanceof Temporal.PlainDateTime
    ) {
        return value.toString();
    }
    throw new Error(
        "Salesforce returned an unsupported date value."
    );
}

function enumOptions(propertyName: string) {
    const property = ontology.objectTypes
        .find(
            (objectType) =>
                objectType.name === "Task"
        )
        ?.properties.find(
            (candidate) =>
                candidate.name === propertyName
        );
    const propertyType:
        | TypeDef
        | undefined = property?.type;
    const type =
        propertyType?.kind === "optional"
            ? propertyType.value.type
            : propertyType;
    if (
        type?.kind !== "string" ||
        type.value.constraint?.kind !== "enum"
    ) {
        return [];
    }
    return type.value.constraint.value.options.map(
        (option) => ({
            value: option.value,
            label: option.label ?? option.value,
        })
    );
}

export async function createTaskManagerDemoRuntime() {
    const settings = getSalesforceSettings();
    const installationId =
        `salesforce-pull:${settings.instanceUrl}:${SALESFORCE_TASK_MANAGER_ONTOLOGY_ID}`;
    const installation =
        await createSalesforceBackendInstallation({
            installationId,
            instanceUrl: settings.instanceUrl,
            apiVersion: settings.apiVersion,
            runtime: createNodeRuntime,
            connections: {
                oauth: {
                    clientId: settings.clientId,
                    redirectUrl:
                        settings.redirectUrl,
                    loginUrl:
                        settings.loginUrl,
                },
            },
            routes: [
                ({ instanceUrl, apiVersion }) => ({
                    matches: (ontologyId) =>
                        ontologyId ===
                        SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
                    configure: ({ egress }) => {
                        const client =
                            createSalesforceClient({
                                instanceUrl,
                                apiVersion,
                                authenticatedFetch: true,
                                fetch: (input, init) =>
                                    egress.fetch(
                                        new Request(
                                            input,
                                            init
                                        )
                                    ),
                            });
                        return {
                            ir: ontology,
                            backend: () =>
                                createTaskManagerBackend(
                                    client
                                ),
                            persistObjects: false,
                        };
                    },
                }),
            ],
        });

    try {
        const restored = [
            ...installation.connections.values(),
        ].find(
            (connection) =>
                connection.state.status ===
                    "active" &&
                (!settings.userId ||
                    connection.userId ===
                        settings.userId)
        );
        const connection =
            restored ??
            (await installation.authentication.signIn.oauth());
        const live =
            await installation.openOntology<SalesforceTaskManagerOntology>(
                {
                    userId: connection.userId,
                    ontologyId:
                        SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
                }
            );
        const listeners = new Set<
            (event: SalesforceChangeEvent) => void
        >();
        const changeSubscription =
            await installation.authentication.subscribeToChangeEvents(
                connection.userId,
                "Task",
                (event) => {
                    const header =
                        event.payload.ChangeEventHeader;
                    const collection =
                        live.objects
                            .Task as unknown as TaskCollection;
                    if (
                        header.changeType === "DELETE"
                    ) {
                        void Promise.all(
                            header.recordIds.map((id) =>
                                collection.utils.deleteByKey(
                                    id
                                )
                            )
                        );
                    }
                    collection.utils.invalidate();
                    for (const listener of listeners) {
                        listener(event);
                    }
                }
            );
        const statusOptions =
            enumOptions("Status");
        const priorityOptions =
            enumOptions("Priority");

        return {
            async getDashboardData() {
                const tasks = await queryOnce((query) =>
                    query
                        .from({
                            Task: live.objects.Task,
                        })
                        .select(({ Task }) => ({
                            ...Task,
                        }))
                        .orderBy(
                            ({ Task }) =>
                                Task.CreatedDate,
                            "desc"
                        )
                        .limit(50)
                );
                const userIds = [
                    ...new Set([
                        connection.userId,
                        ...tasks.map(
                            (task) =>
                                task.CreatedById
                        ),
                    ]),
                ];
                const users = await queryOnce(
                    (query) =>
                        query
                            .from({
                                User: live.objects.User,
                            })
                            .where(({ User }) =>
                                inArray(
                                    User.Id,
                                    userIds
                                )
                            )
                            .select(({ User }) => ({
                                Id: User.Id,
                                Name: User.Name,
                                Username:
                                    User.Username,
                            }))
                );
                const usersById = new Map(
                    users.map((user) => [
                        user.Id,
                        user,
                    ])
                );
                const currentUser =
                    usersById.get(
                        connection.userId
                    );
                return {
                    apiVersion:
                        settings.apiVersion,
                    instanceUrl:
                        settings.instanceUrl,
                    refreshedAt:
                        new Date().toLocaleTimeString(),
                    sobjectCount:
                        ontology.objectTypes.length,
                    user: {
                        id: connection.userId,
                        name:
                            currentUser?.Name ??
                            "Connected Salesforce user",
                        username:
                            currentUser?.Username ??
                            connection.userId,
                    },
                    task: {
                        fieldCount:
                            ontology.objectTypes.find(
                                (objectType) =>
                                    objectType.name ===
                                    "Task"
                            )?.properties.length ??
                            0,
                        defaultStatus:
                            statusOptions[0]?.value ??
                            "Not Started",
                        defaultPriority:
                            priorityOptions.find(
                                (option) =>
                                    option.value ===
                                    "Normal"
                            )?.value ??
                            priorityOptions[0]
                                ?.value ??
                            "Normal",
                        statusOptions,
                        priorityOptions,
                        fields:
                            ontology.objectTypes.find(
                                (objectType) =>
                                    objectType.name ===
                                    "Task"
                            )?.properties.map(
                                (property) => ({
                                    name: property.name,
                                    label:
                                        property.displayName,
                                    type: property.type.kind,
                                })
                            ) ?? [],
                    },
                    tasks: {
                        totalSize: tasks.length,
                        records: tasks.map(
                            (task) => ({
                                Id: task.Id,
                                Subject:
                                    task.Subject,
                                Status:
                                    task.Status,
                                Priority:
                                    task.Priority,
                                ActivityDate:
                                    dateString(
                                        task.ActivityDate
                                    ),
                                CreatedDate:
                                    dateString(
                                        task.CreatedDate
                                    ),
                                CreatedBy: {
                                    Id: task.CreatedById,
                                    Name:
                                        usersById.get(
                                            task.CreatedById
                                        )?.Name,
                                },
                            })
                        ),
                    },
                    flows: {
                        count: ontology.actionTypes.length,
                        actions:
                            ontology.actionTypes.map(
                                (action) => ({
                                    name: action.name,
                                    label:
                                        action.displayName,
                                    type: "runtime",
                                })
                            ),
                    },
                };
            },
            createTask(input: TaskInput) {
                return live.actions.createTask({
                    subject: input.subject,
                    status: input.status,
                    priority: input.priority,
                    activityDate:
                        input.activityDate
                            ? Temporal.PlainDate.from(
                                  input.activityDate
                              )
                            : undefined,
                });
            },
            updateTask(id: string, input: TaskInput) {
                return live.actions.updateTask({
                    task: id,
                    subject: input.subject,
                    status: input.status,
                    priority: input.priority,
                    activityDate:
                        input.activityDate
                            ? Temporal.PlainDate.from(
                                  input.activityDate
                              )
                            : undefined,
                });
            },
            deleteTask(id: string) {
                return live.actions.deleteTask({
                    task: id,
                });
            },
            subscribeToTaskChanges(
                listener: (
                    event: SalesforceChangeEvent
                ) => void
            ) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            changeEventChannel:
                changeSubscription.channel,
            async cleanup() {
                changeSubscription.unsubscribe();
                listeners.clear();
                await installation.cleanup();
            },
        };
    } catch (error) {
        await installation.cleanup();
        throw error;
    }
}
