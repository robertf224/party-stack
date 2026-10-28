import { o } from "../ir/generated/builders.js";
import { validateQueryDocument } from "./validate.js";
import type { Expression, FieldDef, OntologyIR } from "../ir/generated/types.js";
import type { ValidationIssue } from "../utils/validation.js";

export function validatePolicy(ir: OntologyIR): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const policy = ir.policy;
    const add = (message: string, path: (string | number)[]) => issues.push({ message, path });
    const validate = (
        document: Parameters<typeof validateQueryDocument>[1],
        prefix: (string | number)[],
        mode: "projection" | "entity",
        inputs?: readonly FieldDef[]
    ) => {
        if (document.inputs?.length)
            add("Policy reads use bound context and operation parameters, not caller query inputs.", [
                ...prefix,
                "inputs",
            ]);
        for (const issue of validateQueryDocument(ir, document, { mode, inputs }))
            issues.push({ ...issue, path: [...prefix, ...(issue.path ?? [])] });
    };
    if (ir.context?.partition) {
        const paths = ir.context.partition;
        if (
            !paths.length ||
            paths.some(
                (p) => !p.length || p.some((s) => !s || ["__proto__", "constructor", "prototype"].includes(s))
            ) ||
            new Set(paths.map((p) => JSON.stringify(p))).size !== paths.length
        )
            add("Partition paths must be nonempty, distinct property paths.", ["context", "partition"]);
        if (!ir.context.type)
            add("Partition paths require a declared context type.", ["context", "partition"]);
        else
            for (const [index, path] of paths.entries())
                validate(
                    {
                        select: [
                            {
                                kind: "field",
                                value: {
                                    name: "partition",
                                    expression:
                                        path.length === 1
                                            ? o.Expression.contextReference({ name: path[0]! })
                                            : o.Expression.getAt({
                                                  source: o.Expression.contextReference({ name: path[0]! }),
                                                  path: path.slice(1),
                                              }),
                                },
                            },
                        ],
                    },
                    ["context", "partition", index],
                    "projection"
                );
    }
    if (!policy) return issues;
    validate(policy.read, ["policy", "read"], "entity");
    const seen = new Set<string>();
    for (const [index, rule] of (policy.actions ?? []).entries()) {
        const path = ["policy", "actions", index];
        const action = ir.actionTypes.find((a) => a.name === rule.actionType);
        if (!action || seen.has(rule.actionType)) {
            add("Action policy references an unknown or duplicate action.", path);
            continue;
        }
        seen.add(rule.actionType);
        const check: Expression = o.Expression.not({ expression: rule.check });
        validate(
            { select: [{ kind: "field", value: { name: "check", expression: check } }] },
            path,
            "projection",
            action.parameters
        );
        const bound = new Set<string>();
        for (const [i, binding] of (rule.bind ?? []).entries()) {
            if (!action.parameters.some((p) => p.name === binding.parameter) || bound.has(binding.parameter))
                add("Unknown or duplicate bound action parameter.", [...path, "bind", i]);
            bound.add(binding.parameter);
            validate(
                {
                    select: [
                        {
                            kind: "field",
                            value: {
                                name: "binding",
                                expression: o.Expression.eq({
                                    left: o.Expression.inputReference({ name: binding.parameter }),
                                    right: binding.expression,
                                }),
                            },
                        },
                    ],
                },
                [...path, "bind", i],
                "projection",
                action.parameters
            );
        }
        const dependencies = new Map(
            (rule.bind ?? []).map((binding) => {
                const names = new Set<string>();
                const visit = (value: unknown): void => {
                    if (!value || typeof value !== "object") return;
                    if ("kind" in value && value.kind === "literal") return;
                    if ("kind" in value && value.kind === "inputReference" && "value" in value)
                        names.add((value.value as { name: string }).name);
                    else
                        Object.values(value).forEach((v) => (Array.isArray(v) ? v.forEach(visit) : visit(v)));
                };
                visit(binding.expression);
                return [binding.parameter, names] as const;
            })
        );
        const visiting = new Set<string>(),
            done = new Set<string>();
        const walk = (name: string): boolean => {
            if (visiting.has(name)) return false;
            if (done.has(name)) return true;
            visiting.add(name);
            for (const dependency of dependencies.get(name) ?? [])
                if (dependencies.has(dependency) && !walk(dependency)) return false;
            visiting.delete(name);
            done.add(name);
            return true;
        };
        if ([...dependencies.keys()].some((name) => !walk(name)))
            add("Cyclic action parameter bindings.", [...path, "bind"]);
        if (rule.read) validate(rule.read, [...path, "read"], "entity", action.parameters);
    }
    const functions = new Set<string>();
    for (const [index, rule] of (policy.queryFunctions ?? []).entries()) {
        const path = ["policy", "queryFunctions", index];
        const query = ir.queryFunctionTypes.find((q) => q.name === rule.queryFunctionType);
        if (!query || functions.has(rule.queryFunctionType)) {
            add("Query-function policy references an unknown or duplicate function.", path);
            continue;
        }
        functions.add(rule.queryFunctionType);
        validate(
            {
                select: [
                    {
                        kind: "field",
                        value: { name: "check", expression: o.Expression.not({ expression: rule.check }) },
                    },
                ],
            },
            path,
            "projection",
            query.parameters
        );
        if (rule.read) validate(rule.read, [...path, "read"], "entity", query.parameters);
    }
    return issues;
}
