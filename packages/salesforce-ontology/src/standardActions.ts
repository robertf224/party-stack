export type SalesforceStandardActionKind = "action" | "queryFunction";

/**
 * Standard actions have Salesforce-owned, versioned semantics. Keep this list
 * conservative: unknown operations are treated as mutating actions.
 */
const QUERY_FUNCTIONS = new Set([
    "cdpGetDataGraphByLookup",
    "cdpGetDataGraphMetadata",
    "exploreConversation",
    "getArticleSmartLinkUrl",
    "getAvailableMeetingTimes",
    "getConversationIntelligence",
    "getConversationTranscript",
    "getDataCategoryDetails",
    "getDataCategoryGroups",
    "previewCartToExchangeOrder",
    "searchKnowledgeArticles",
    "summarizeRecord",
]);

export function classifySalesforceStandardAction(name: string): SalesforceStandardActionKind {
    return QUERY_FUNCTIONS.has(name) ? "queryFunction" : "action";
}
