import type { IconProvider } from "./types";

export type MappingFeedbackDecision = "approve" | "reject" | "replace";

export interface MappingFeedback {
    concept: string;
    provider: IconProvider;
    currentName: string;
    decision: MappingFeedbackDecision;
    replacementName?: string;
    note?: string;
    updatedAt: string;
}

export interface MappingFeedbackFile {
    version: 1;
    generatedAt: string;
    feedback: MappingFeedback[];
    confirmedConcepts: string[];
}

export const MappingFeedbackStorageKey = "party-stack.icon-lab.mapping-feedback.v1";
export const MappingConfirmationsStorageKey = "party-stack.icon-lab.mapping-confirmations.v1";

export function mappingFeedbackKey(concept: string, provider: IconProvider): string {
    return `${concept}::${provider}`;
}

export function loadMappingFeedback(storage: Pick<Storage, "getItem"> = localStorage): MappingFeedback[] {
    try {
        const value = storage.getItem(MappingFeedbackStorageKey);
        if (!value) {
            return [];
        }
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed)
            ? (parsed as MappingFeedback[]).filter(
                  (item) => item.decision !== "replace" || Boolean(item.replacementName?.trim())
              )
            : [];
    } catch {
        return [];
    }
}

export function saveMappingFeedback(
    feedback: MappingFeedback[],
    storage: Pick<Storage, "setItem"> = localStorage
): void {
    try {
        storage.setItem(MappingFeedbackStorageKey, JSON.stringify(feedback));
    } catch {
        // Keep the in-memory review session usable when browser storage is unavailable.
    }
}

export function loadMappingConfirmations(storage: Pick<Storage, "getItem"> = localStorage): string[] {
    try {
        const value = storage.getItem(MappingConfirmationsStorageKey);
        if (!value) {
            return [];
        }
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed)
            ? [...new Set(parsed.filter((item): item is string => typeof item === "string"))]
            : [];
    } catch {
        return [];
    }
}

export function saveMappingConfirmations(
    concepts: string[],
    storage: Pick<Storage, "setItem"> = localStorage
): void {
    try {
        storage.setItem(MappingConfirmationsStorageKey, JSON.stringify([...new Set(concepts)].sort()));
    } catch {
        // Keep the in-memory review session usable when browser storage is unavailable.
    }
}

export function createMappingFeedbackFile(
    feedback: MappingFeedback[],
    generatedAt = new Date().toISOString(),
    confirmedConcepts: string[] = []
): MappingFeedbackFile {
    return {
        version: 1,
        generatedAt,
        confirmedConcepts: [...new Set(confirmedConcepts)].sort(),
        feedback: [...feedback].sort(
            (left, right) =>
                left.concept.localeCompare(right.concept) || left.provider.localeCompare(right.provider)
        ),
    };
}
