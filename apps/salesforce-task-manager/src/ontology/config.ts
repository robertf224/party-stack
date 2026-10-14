import {
    createSalesforceOntologyPullConfig,
    type SalesforceOntologyPullConfig,
} from "@party-stack/salesforce-ontology/config";
import {
    getSalesforceSettings,
    SALESFORCE_TASK_MANAGER_OBJECT_TYPES,
    SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
} from "../settings.js";
import { projectTaskManagerOntology } from "./transform.js";

const settings = getSalesforceSettings();

export default createSalesforceOntologyPullConfig({
    instanceUrl: settings.instanceUrl,
    apiVersion: settings.apiVersion,
    ontologyId: SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
    objectTypeNames: SALESFORCE_TASK_MANAGER_OBJECT_TYPES,
    flowActionTypeNames: ["sales_sfa_flows__CreateSalesLead"],
    standardActionTypeNames: ["confirmSalesMeeting"],
    standardQueryFunctionTypeNames: ["getAvailableMeetingTimes"],
    crudActionTypes: [
        {
            objectType: "Task",
            operations: ["create", "update", "delete"],
        },
    ],
    transformPulledOntology: projectTaskManagerOntology,
    connection: {
        userId: settings.userId,
        oauth: {
            clientId: settings.clientId,
            redirectUrl: settings.redirectUrl,
            loginUrl: settings.loginUrl,
        },
    },
}) satisfies SalesforceOntologyPullConfig;
