import { validatePolicy, selectedProperty, validateQueryDocument } from "@party-stack/ontology-spec/query";
import { field as ref, eq, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { BackendError } from "../index.js";
import { queryExecutor } from "../query.js";
import { authorizationPlans } from "./planner.js";
import type { OwnedReadTransaction } from "../owned.js";
import type { QueryEntity, QueryReader } from "../query.js";
import type { OntologyIR, Query, QueryDocument, QuerySelection } from "@party-stack/ontology-spec";
import type { Query as Scan, Key, Row } from "@party-stack/ontology-storage";

export const denied = (operation: string) =>
    new BackendError({
        operation,
        kind: "Forbidden",
        message: "This operation is not permitted.",
        retryable: false,
        actionOutcome: "not-committed",
    });
const keyOf = (type: string, key: Key) => JSON.stringify([type, key]);

export function policyProperties(ir: OntologyIR) {
    const allowed = new Map<string, Set<string>>();
    const guaranteed = new Map<string, Set<string>>();
    function query(q: Query) {
        if (q.from.source.ontology) return;
        const object = ir.objectTypes.find((t) => t.name === q.from.source.objectType);
        if (!object) return;
        const upper = allowed.get(object.name) ?? new Set<string>();
        const always = new Set([object.primaryKey]);
        upper.add(object.primaryKey);
        function selections(items: readonly QuerySelection[], conditional: boolean) {
            for (const item of items) {
                if (item.kind === "sub") query(item.value.query);
                else if (item.kind === "selectCase") {
                    for (const branch of item.value.branches) selections(branch.select, true);
                    selections(item.value.else ?? [], true);
                } else {
                    const p = selectedProperty(item.value.expression);
                    if (p?.binding === q.from.binding) {
                        upper.add(p.property);
                        if (!conditional) always.add(p.property);
                    }
                }
            }
        }
        selections(q.select, false);
        const existing = guaranteed.get(object.name);
        guaranteed.set(object.name, existing ? new Set([...existing].filter((p) => always.has(p))) : always);
        allowed.set(object.name, upper);
    }
    function roots(items: readonly QuerySelection[]) {
        for (const item of items) {
            if (item.kind === "sub") query(item.value.query);
            else if (item.kind === "selectCase") {
                item.value.branches.forEach((b) => roots(b.select));
                roots(item.value.else ?? []);
            }
        }
    }
    roots(ir.policy?.read.select ?? []);
    return { allowed, guaranteed };
}
function filterFields(query: Scan): Set<string> {
    const result = new Set<string>();
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if ("_tag" in value && value._tag === "Field" && "path" in value && Array.isArray(value.path)) {
            result.add(value.path[0]);
            return;
        }
        Object.values(value).forEach((v) => (Array.isArray(v) ? v.forEach(visit) : visit(v)));
    };
    visit(query.where);
    query.orderBy?.forEach((o) => result.add(o.field.path[0]!));
    return result;
}
export interface PolicyViewOptions {
    readonly extraRead?: QueryDocument;
    readonly inputs?: Record<string, unknown>;
    readonly inputDefinitions?: readonly import("@party-stack/ontology-spec").FieldDef[];
}

/** Bound to one authenticated context. Underlying reader is trusted and owns transaction lifetime. */
export function evaluatePolicyView(
    reader: QueryReader,
    context: Record<string, unknown>,
    options?: PolicyViewOptions,
    strategy: "rewrite" | "eager" = "rewrite"
) {
    const ir = reader.ir;
    const issues = validatePolicy(ir);
    if (issues.length)
        throw new BackendError({
            operation: "policy",
            kind: "InvalidConfiguration",
            message: "Invalid ontology policy.",
            retryable: false,
            issues,
        });
    if (!ir.policy)
        throw new BackendError({
            operation: "policy",
            kind: "InvalidConfiguration",
            message: "An explicit ontology policy is required.",
            retryable: false,
        });
    const documents = [ir.policy.read, ...(options?.extraRead ? [options.extraRead] : [])];
    const properties = policyProperties(
        options?.extraRead
            ? {
                  ...ir,
                  policy: {
                      ...ir.policy,
                      read: { select: [...ir.policy.read.select, ...options.extraRead.select] },
                  },
              }
            : ir
    );
    const readable = new WeakMap<object, Set<string>>();
    const loadSubset = Effect.fn("Policy.loadSubset")(function* (objectType: string, query: Scan = {}) {
        const guaranteed = properties.guaranteed.get(objectType);
        if (!guaranteed || [...filterFields(query)].some((f) => !guaranteed.has(f)))
            return yield* denied("loadSubset");
        const grants = new Map<string, { value: Record<string, unknown>; fields: Set<string>; key: Key }>();
        for (const document of documents) {
            const proposed =
                strategy === "eager" ? [document] : authorizationPlans(document, objectType, query);
            // A physical caller predicate may use semantics the logical IR cannot
            // express yet. Keep the original plan rather than changing behavior.
            const plans = proposed.some(
                (plan) =>
                    validateQueryDocument(ir, plan, { mode: "entity", inputs: options?.inputDefinitions })
                        .length
            )
                ? [document]
                : proposed;
            for (const plan of plans) {
                const result = yield* queryExecutor({
                    reader,
                    context,
                    inputs: options?.inputs,
                    inputDefinitions: options?.inputDefinitions,
                    mode: "entity",
                }).run(plan);
                for (const entity of result.entities) {
                    if (entity.source || entity.objectType !== objectType) continue;
                    const key = keyOf(entity.objectType, entity.key);
                    const grant = grants.get(key) ?? {
                        value: entity.value,
                        key: entity.key,
                        fields: new Set<string>(),
                    };
                    entity.properties.forEach((property) => grant.fields.add(property));
                    grants.set(key, grant);
                }
            }
        }
        const rows: Row<Record<string, unknown>>[] = [];
        for (const grant of grants.values()) {
            const value = Object.fromEntries(
                Object.entries(grant.value).filter(([property]) => grant.fields.has(property))
            );
            readable.set(value, grant.fields);
            rows.push({ key: grant.key, value });
        }
        return yield* Effect.try({
            try: () => evaluateQuery(rows, query),
            catch: () =>
                new BackendError({
                    operation: "loadSubset",
                    kind: "InvalidRequest",
                    message: "Invalid authorized subset query.",
                    retryable: false,
                }),
        });
    });
    const tx: OwnedReadTransaction = {
        loadSubset,
        get: Effect.fnUntraced(function* (objectType, key) {
            const object = ir.objectTypes.find((t) => t.name === objectType);
            if (!object) return yield* denied("get");
            const rows = yield* loadSubset(objectType, { where: eq(ref(object.primaryKey), key), limit: 1 });
            return rows[0]?.value;
        }),
    };
    return {
        ...properties,
        reader: { ir, loadSubset } satisfies QueryReader,
        tx,
        canReadProperty: (entity: QueryEntity, property: string) =>
            readable.get(entity.value)?.has(property) ?? false,
    };
}
