export const SALESFORCE_TASK_MANAGER_ONTOLOGY_ID =
    "salesforce:task-manager";
export const SALESFORCE_TASK_MANAGER_OBJECT_TYPES = [
    "Task",
    "User",
];

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(
            `Missing required environment variable ${name}.`
        );
    }
    return value;
}

export function getSalesforceSettings() {
    const instanceUrl = requiredEnv(
        "SALESFORCE_INSTANCE_URL"
    );
    return {
        instanceUrl,
        loginUrl:
            process.env.SALESFORCE_LOGIN_URL?.trim() ??
            instanceUrl,
        apiVersion:
            process.env.SALESFORCE_API_VERSION?.trim() ??
            "65.0",
        clientId: requiredEnv(
            "SALESFORCE_CLIENT_ID"
        ),
        redirectUrl:
            process.env.SALESFORCE_REDIRECT_URL?.trim() ??
            "http://localhost:1717/oauth/callback",
        userId:
            process.env.SALESFORCE_USER_ID?.trim() ||
            undefined,
    };
}
