import { INCOMPATIBLE_DEFAULT, validate } from "./validate.js";
import type { ValidationIssue } from "../utils/validation.js";
import type { OntologyIR } from "./generated/types.js";

const sections = ["types", "objectTypes", "linkTypes", "actionTypes", "queryFunctionTypes"] as const;
/** A top-level list of definitions in the IR. */
export type OntologySection = (typeof sections)[number];

/** Something `omitInvalid` dropped to make the Ontology valid. */
export interface OmittedDefinition {
    /** A whole definition, or only one action parameter's default. */
    readonly kind: "definition" | "defaultValue";
    readonly section: OntologySection;
    /** The definition's name; a link type's id. */
    readonly name: string;
    /** For a dropped default: the parameter, which keeps its type. */
    readonly parameter?: string;
    /** Why, with paths relative to the definition. */
    readonly issues: readonly ValidationIssue[];
}

export interface OmitInvalidResult {
    readonly ontology: OntologyIR;
    readonly omitted: readonly OmittedDefinition[];
    /**
     * Issues omission cannot fix, such as an invalid policy or context. When this is empty,
     * `ontology` is valid.
     */
    readonly issues: readonly ValidationIssue[];
}

const isSection = (value: unknown): value is OntologySection =>
    (sections as readonly unknown[]).includes(value);

const nameOf = (section: OntologySection, definition: { name?: string; id?: string }) =>
    (section === "linkTypes" ? definition.id : definition.name) ?? "";

function append<K>(
    map: Map<K, Map<number, ValidationIssue[]>>,
    key: K,
    index: number,
    issue: ValidationIssue
) {
    const entries = map.get(key) ?? new Map<number, ValidationIssue[]>();
    entries.set(index, [...(entries.get(index) ?? []), issue]);
    map.set(key, entries);
}

/**
 * Drop whatever `validate` rejects, so one bad definition does not make a whole Ontology unusable.
 *
 * A default whose type does not fit its parameter loses only the default. Any other issue drops
 * the definition it sits under (value type, object type, link type, action type or query function
 * type). Validation then runs again, so definitions that depended on a dropped one (for example
 * links and actions referencing a dropped object type) are dropped in turn.
 *
 * Producers such as metadata pulls call this and report `omitted`; a consumer that wants a strict
 * Ontology treats a non-empty `omitted` as a failure.
 */
export function omitInvalid(ontology: OntologyIR): OmitInvalidResult {
    const omitted: OmittedDefinition[] = [];
    let current = ontology;
    for (;;) {
        const result = validate(current);
        if (result.kind === "ok") return { ontology: current, omitted, issues: [] };

        const definitions = new Map<OntologySection, Map<number, ValidationIssue[]>>();
        const defaults = new Map<number, Map<number, ValidationIssue[]>>();
        const issues: ValidationIssue[] = [];
        for (const issue of result.value) {
            const [section, index, member, parameterIndex] = issue.path ?? [];
            if (!isSection(section) || typeof index !== "number" || !current[section][index]) {
                issues.push(issue);
                continue;
            }
            const relative = { ...issue, path: issue.path!.slice(2) };
            if (
                issue.code === INCOMPATIBLE_DEFAULT &&
                section === "actionTypes" &&
                member === "parameters" &&
                typeof parameterIndex === "number"
            )
                append(defaults, index, parameterIndex, { ...relative, path: relative.path.slice(2) });
            else append(definitions, section, index, relative);
        }
        if (definitions.size === 0 && defaults.size === 0) return { ontology: current, omitted, issues };

        const next = { ...current };
        for (const section of sections) {
            const dropped = definitions.get(section);
            const list = current[section] as readonly { name?: string; id?: string }[];
            for (const [index, cause] of [...(dropped ?? [])].sort(([a], [b]) => a - b))
                omitted.push({
                    kind: "definition",
                    section,
                    name: nameOf(section, list[index]!),
                    issues: cause,
                });
            if (dropped)
                (next as Record<string, unknown>)[section] = list.filter((_, index) => !dropped.has(index));
        }
        const droppedActions = definitions.get("actionTypes");
        next.actionTypes = current.actionTypes.flatMap((action, actionIndex) => {
            if (droppedActions?.has(actionIndex)) return [];
            const parameters = defaults.get(actionIndex);
            if (!parameters) return [action];
            return [
                {
                    ...action,
                    parameters: action.parameters.map((parameter, parameterIndex) => {
                        const cause = parameters.get(parameterIndex);
                        if (!cause) return parameter;
                        omitted.push({
                            kind: "defaultValue",
                            section: "actionTypes",
                            name: action.name,
                            parameter: parameter.name,
                            issues: cause,
                        });
                        const { defaultValue: _, ...rest } = parameter;
                        return rest;
                    }),
                },
            ];
        });
        current = next;
    }
}
