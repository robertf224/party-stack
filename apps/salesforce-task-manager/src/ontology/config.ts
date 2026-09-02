import {
    createSalesforceOntologyPullConfig,
    type SalesforceOntologyPullConfig,
} from "@party-stack/salesforce-ontology/config";
import {
    getSalesforceSettings,
    SALESFORCE_TASK_MANAGER_OBJECT_TYPES,
    SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
} from "../settings.js";
import { addTaskManagerActions } from "./transform.js";

const settings = getSalesforceSettings();

export default createSalesforceOntologyPullConfig({
    instanceUrl: settings.instanceUrl,
    apiVersion: settings.apiVersion,
    ontologyId:
        SALESFORCE_TASK_MANAGER_ONTOLOGY_ID,
    objectTypeNames:
        SALESFORCE_TASK_MANAGER_OBJECT_TYPES,
    actionTypeNames: [],
    transformPulledOntology:
        addTaskManagerActions,
    connection: {
        userId: settings.userId,
        oauth: {
            clientId: settings.clientId,
            redirectUrl: settings.redirectUrl,
            loginUrl: settings.loginUrl,
        },
    },
}) satisfies SalesforceOntologyPullConfig;
