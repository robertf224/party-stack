import { invariant } from "@bobbyfidz/panic";
import {
    bulkLoadOntologyEntities,
    type Condition,
    type ConditionValue,
} from "@osdk/client.unstable";
import { GroupMemberships, Users } from "@osdk/foundry.admin";
import {
    ActionTypesV2,
    type ParameterEvaluatedConstraint,
    type StringRegexMatchConstraint,
    type StructEvaluatedConstraint,
    type SyncApplyActionResponseV2,
} from "@osdk/foundry.ontologies";
import {
    certain,
    uncertain,
    type Uncertain,
    type ValidationIssue,
} from "@party-stack/ontology";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { Result } from "@party-stack/ontology/values";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import * as AsyncIterable from "../utils/AsyncIterable.js";

export interface FoundrySubmissionCriterion {
    condition: Condition;
    failureMessage: string;
}

function valuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            left.every((value, index) => valuesEqual(value, right[index]))
        );
    }
    if (
        typeof left === "object" &&
        left !== null &&
        typeof right === "object" &&
        right !== null
    ) {
        const leftEntries = Object.entries(left);
        const rightRecord = right as Record<string, unknown>;
        return (
            leftEntries.length === Object.keys(rightRecord).length &&
            leftEntries.every(([key, value]) => valuesEqual(value, rightRecord[key]))
        );
    }
    return false;
}

export async function loadFoundrySubmissionCriteria(options: {
    client: OntologyClient;
    actionTypeName: string;
    userId: string;
}): Promise<FoundrySubmissionCriterion[]> {
    const actionType = await ActionTypesV2.get(
        options.client,
        options.client.ontologyRid,
        toFoundryActionTypeName(options.actionTypeName)
    );
    const response = await bulkLoadOntologyEntities(
        {
            ...options.client,
            servicePath: "ontology-metadata/api",
        },
        options.userId,
        {
            actionTypes: [{ rid: actionType.rid }],
            datasourceTypes: [],
            interfaceTypes: [],
            linkTypes: [],
            objectTypes: [],
            sharedPropertyTypes: [],
            typeGroups: [],
        }
    );
    const loaded = response.actionTypes[0];
    invariant(loaded, `Foundry action type "${options.actionTypeName}" was not returned by metadata.`);
    return Object.values(
        loaded.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules
    ).map((rule) => ({
        condition: rule.condition,
        failureMessage: rule.displayMetadata.failureMessage,
    }));
}

interface EvaluationContext {
    client: OntologyClient;
    userId: string;
    parameters: Record<string, unknown>;
    knownParameters: ReadonlySet<string>;
    groupIds: () => Promise<string[]>;
    markings: () => Promise<string[]>;
    user: () => ReturnType<typeof Users.get>;
}

function createEvaluationContext(options: {
    client: OntologyClient;
    userId: string;
    parameters: Record<string, unknown>;
    knownParameters?: ReadonlySet<string>;
}): EvaluationContext {
    let groupIds: Promise<string[]> | undefined;
    let markings: Promise<string[]> | undefined;
    let user: ReturnType<typeof Users.get> | undefined;

    return {
        ...options,
        knownParameters: options.knownParameters ?? new Set(Object.keys(options.parameters)),
        groupIds: () => {
            groupIds ??= loadGroupIds(options.client, options.userId);
            return groupIds;
        },
        markings: () => {
            markings ??= Users.getMarkings(options.client, options.userId).then(
                (response) => response.view
            );
            return markings;
        },
        user: () => {
            user ??= Users.get(options.client, options.userId);
            return user;
        },
    };
}

async function loadGroupIds(client: OntologyClient, userId: string): Promise<string[]> {
    return AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                GroupMemberships.list(client, userId, {
                    pageSize,
                    pageToken,
                    transitive: true,
                }),
            (page) => page.nextPageToken,
            (page) => page.data.map((membership) => membership.groupId),
            1_000
        )
    );
}

function evaluateStaticValue(value: ConditionValue & { type: "staticValue" }): Uncertain<unknown> {
    const staticValue = value.staticValue;
    switch (staticValue.type) {
        case "boolean":
            return certain(staticValue.boolean);
        case "integer":
            return certain(staticValue.integer);
        case "long":
            return certain(staticValue.long);
        case "double":
            return certain(staticValue.double);
        case "string":
            return certain(staticValue.string);
        case "timestamp":
            return certain(staticValue.timestamp);
        case "booleanList":
            return certain(staticValue.booleanList.booleans);
        case "integerList":
            return certain(staticValue.integerList.integers);
        case "longList":
            return certain(staticValue.longList.longs);
        case "doubleList":
            return certain(staticValue.doubleList.doubles);
        case "stringList":
            return certain(staticValue.stringList.strings);
        case "timestampList":
            return certain(staticValue.timestampList.timestamps);
        case "decimal":
            return certain(staticValue.decimal.decimalValue);
        case "decimalList":
            return certain(staticValue.decimalList.decimals);
        case "date":
            return certain(staticValue.date.dateValue);
        case "dateList":
            return certain(staticValue.dateList.dates);
        case "marking":
            return certain(staticValue.marking.marking);
        case "markingList":
            return certain(staticValue.markingList.markings);
        case "attachment":
            return certain(staticValue.attachment.attachment);
        case "attachmentList":
            return certain(staticValue.attachmentList.attachments);
        case "objectType":
            return certain(staticValue.objectType.objectTypeId);
        case "null":
            return certain(null);
        default:
            return uncertain();
    }
}

async function evaluateUserProperty(
    value: ConditionValue & { type: "userProperty" },
    context: EvaluationContext
): Promise<Uncertain<unknown>> {
    switch (value.userProperty.propertyValue.type) {
        case "userId":
            return certain(context.userId);
        case "groupIds":
            return certain(await context.groupIds());
        case "organizationMarkingIds":
            return certain(await context.markings());
        case "userName":
            return certain((await context.user()).username);
        case "userAttributes": {
            const user = await context.user();
            return certain(
                user.attributes[value.userProperty.propertyValue.userAttributes.attributeKey]
            );
        }
        case "groupNames":
            return uncertain();
    }
}

async function evaluateConditionValue(
    value: ConditionValue,
    context: EvaluationContext
): Promise<Uncertain<unknown>> {
    switch (value.type) {
        case "staticValue":
            return evaluateStaticValue(value);
        case "userProperty":
            return evaluateUserProperty(value, context);
        case "parameterId": {
            const parameterName = value.parameterId;
            const parameterValue = context.parameters[parameterName];
            return parameterValue !== undefined || context.knownParameters.has(parameterName)
                ? certain(parameterValue)
                : uncertain();
        }
        case "parameterLength": {
            const parameterName = value.parameterLength.parameterId;
            const parameterValue = context.parameters[parameterName];
            return typeof parameterValue === "string" || Array.isArray(parameterValue)
                ? certain(parameterValue.length)
                : uncertain();
        }
        case "objectParameterPropertyValue":
        case "interfaceParameterPropertyValue":
        case "interfaceParameterPropertyValueV2":
            return uncertain();
    }
}

function evaluateOrderedComparison(
    operator: "LESS_THAN" | "LESS_THAN_EQUALS" | "GREATER_THAN" | "GREATER_THAN_EQUALS",
    left: unknown,
    right: unknown
): Uncertain<boolean> {
    if (
        !(
            (typeof left === "number" && typeof right === "number") ||
            (typeof left === "string" && typeof right === "string")
        )
    ) {
        return uncertain();
    }
    switch (operator) {
        case "LESS_THAN":
            return certain(left < right);
        case "LESS_THAN_EQUALS":
            return certain(left <= right);
        case "GREATER_THAN":
            return certain(left > right);
        case "GREATER_THAN_EQUALS":
            return certain(left >= right);
    }
}

async function evaluateCondition(
    condition: Condition,
    context: EvaluationContext
): Promise<Uncertain<boolean>> {
    switch (condition.type) {
        case "true":
            return certain(true);
        case "redacted":
            return uncertain();
        case "and": {
            const results = await Promise.all(
                condition.and.conditions.map((child) => evaluateCondition(child, context))
            );
            if (results.some((result) => result.certain && !result.value)) {
                return certain(false);
            }
            return results.some((result) => !result.certain)
                ? uncertain()
                : certain(true);
        }
        case "or": {
            const results = await Promise.all(
                condition.or.conditions.map((child) => evaluateCondition(child, context))
            );
            if (results.some((result) => result.certain && result.value)) {
                return certain(true);
            }
            return results.some((result) => !result.certain)
                ? uncertain()
                : certain(false);
        }
        case "not": {
            const result = await evaluateCondition(condition.not.condition, context);
            return result.certain ? certain(!result.value) : result;
        }
        case "comparison": {
            const [left, right] = await Promise.all([
                evaluateConditionValue(condition.comparison.left, context),
                evaluateConditionValue(condition.comparison.right, context),
            ]);
            if (!left.certain || !right.certain) {
                return uncertain();
            }
            switch (condition.comparison.operator) {
                case "EQUALS":
                    return certain(valuesEqual(left.value, right.value));
                case "NOT_EQUALS":
                    return certain(!valuesEqual(left.value, right.value));
                case "INTERSECTS": {
                    const leftValues = Array.isArray(left.value) ? left.value : [left.value];
                    const rightValues = new Set(
                        Array.isArray(right.value) ? right.value : [right.value]
                    );
                    return certain(leftValues.some((entry) => rightValues.has(entry)));
                }
                case "LESS_THAN":
                case "LESS_THAN_EQUALS":
                case "GREATER_THAN":
                case "GREATER_THAN_EQUALS":
                    return evaluateOrderedComparison(
                        condition.comparison.operator,
                        left.value,
                        right.value
                    );
                case "IS_OF_OBJECT_TYPE":
                    return uncertain();
                default:
                    return uncertain();
            }
        }
        case "regex": {
            const value = await evaluateConditionValue(condition.regex.value, context);
            if (!value.certain) return value;
            if (typeof value.value !== "string") {
                return uncertain();
            }
            try {
                return certain(new RegExp(condition.regex.regex).test(value.value));
            } catch {
                return uncertain();
            }
        }
        case "markings":
            return uncertain();
        case "executionContext":
            return uncertain();
    }
}

export async function validateFoundryActionDraftCriteria(options: {
    client: OntologyClient;
    criteria: FoundrySubmissionCriterion[];
    userId: string;
    parameters: Record<string, unknown>;
    knownParameters?: ReadonlySet<string>;
}): Promise<Uncertain<Result<void, readonly ValidationIssue[]>>> {
    const context = createEvaluationContext(options);
    const evaluated = await Promise.all(
        options.criteria.map(async (criterion) => ({
            criterion,
            result: await evaluateCondition(criterion.condition, context),
        }))
    );
    const errors = evaluated
        .filter(({ result }) => result.certain && !result.value)
        .map(({ criterion }) => ({
            message: `Impossible submission criterion: ${criterion.failureMessage}`,
        }));
    return errors.length > 0
        ? certain({
              kind: "err",
              value: errors,
          })
        : uncertain();
}

function collectRegexIssue(
    constraint: StringRegexMatchConstraint,
    issues: ValidationIssue[],
    path: readonly (string | number)[]
): void {
    if (constraint.configuredFailureMessage) {
        issues.push({
            message: constraint.configuredFailureMessage,
            path,
        });
    }
}

function collectStructIssues(
    constraint: StructEvaluatedConstraint,
    issues: ValidationIssue[],
    path: readonly (string | number)[]
): void {
    for (const [fieldName, field] of Object.entries(constraint.structFields)) {
        if (field.result !== "INVALID") continue;
        for (const fieldConstraint of field.evaluatedConstraints) {
            if (fieldConstraint.type === "stringRegexMatch") {
                collectRegexIssue(fieldConstraint, issues, [...path, fieldName]);
            }
        }
    }
}

function collectParameterConstraintIssues(
    constraint: ParameterEvaluatedConstraint,
    issues: ValidationIssue[],
    path: readonly (string | number)[]
): void {
    switch (constraint.type) {
        case "stringRegexMatch":
            collectRegexIssue(constraint, issues, path);
            break;
        case "struct":
            collectStructIssues(constraint, issues, path);
            break;
        case "array":
            for (const [index, entry] of constraint.entries.entries()) {
                collectStructIssues(entry, issues, [...path, index]);
            }
            break;
    }
}

export function getFoundryValidationIssues(result: SyncApplyActionResponseV2): ValidationIssue[] {
    const validation = result.validation;
    if (!validation || validation.result !== "INVALID") return [];

    const issues = validation.submissionCriteria.flatMap((criterion) =>
        criterion.result === "INVALID" && criterion.configuredFailureMessage
            ? [{ message: criterion.configuredFailureMessage }]
            : []
    );
    for (const [parameterName, parameter] of Object.entries(validation.parameters)) {
        if (parameter.result !== "INVALID") continue;
        for (const constraint of parameter.evaluatedConstraints) {
            collectParameterConstraintIssues(constraint, issues, [parameterName]);
        }
    }
    return issues.length > 0
        ? issues
        : [{ message: "Invalid Action arguments." }];
}
