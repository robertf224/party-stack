import { createLocalSalesforceSession } from "./create-local-session.mjs";

function flowActionCount(response) {
    if (Array.isArray(response)) return response.length;
    if (Array.isArray(response?.actions)) return response.actions.length;
    if (response && typeof response === "object") return Object.keys(response).length;
    return 0;
}

const local = await createLocalSalesforceSession();
const { client, session } = local;

try {
    console.log(`✓ OAuth login succeeded for Salesforce user ${session.userId}`);

    const globalDescribe = await client.describeGlobal();
    console.log(`✓ Global describe returned ${globalDescribe.sobjects.length} sObjects`);

    const taskDescribe = await client.describeSObject("Task");
    const fieldNames = new Set(taskDescribe.fields.map((field) => field.name));
    for (const requiredField of ["Id", "Subject", "Status"]) {
        if (!fieldNames.has(requiredField)) {
            throw new Error(`Task describe is missing expected field ${requiredField}.`);
        }
    }
    console.log(`✓ Task describe returned ${taskDescribe.fields.length} fields`);

    const tasks = await client.query(
        "SELECT Id, Status, Priority, ActivityDate, CreatedDate FROM Task ORDER BY CreatedDate DESC LIMIT 5"
    );
    console.log(
        `✓ Task SOQL query succeeded (${tasks.records.length} returned, ${tasks.totalSize} total)`
    );

    try {
        const flowActions = await client.listFlowActions();
        console.log(`✓ Flow Actions endpoint returned ${flowActionCount(flowActions)} actions`);
    } catch (error) {
        console.warn(
            `! Core smoke test passed, but Flow Actions could not be listed: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    console.log("\nSalesforce adapter smoke test passed.");
} finally {
    await local.cleanup();
}
