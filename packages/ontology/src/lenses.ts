import { capitalCase } from "change-case";
import { get, set, unset } from "lodash-es";
import type { FieldDef, Lens, ObjectTypeDef, PropertyDef, TypeDef } from "./ir/index.js";

export interface ApplyObjectTypeLensOptions {
    name: string;
    displayName?: string;
    pluralDisplayName?: string;
}

function structFields(type: TypeDef): FieldDef[] | undefined {
    if (type.kind === "struct") return type.value.fields;
    if (type.kind === "optional" && type.value.type.kind === "struct") {
        return type.value.type.value.fields;
    }
    return undefined;
}

function removeField(fields: PropertyDef[] | FieldDef[], path: readonly string[]): PropertyDef | FieldDef {
    const [name, ...rest] = path;
    if (!name) throw new Error("Lens paths must not be empty.");
    const index = fields.findIndex((field) => field.name === name);
    if (index < 0) throw new Error(`Lens source path "${path.join(".")}" does not exist.`);
    if (rest.length === 0) return fields.splice(index, 1)[0]!;

    const nested = structFields(fields[index]!.type);
    if (!nested) throw new Error(`Lens source path "${path.join(".")}" does not traverse a struct.`);
    return removeField(nested, rest);
}

function insertField(
    fields: PropertyDef[] | FieldDef[],
    path: readonly string[],
    field: PropertyDef | FieldDef
): void {
    const [name, ...rest] = path;
    if (!name) throw new Error("Lens paths must not be empty.");
    if (rest.length === 0) {
        if (fields.some((candidate) => candidate.name === name)) {
            throw new Error(`Lens target path "${path.join(".")}" already exists.`);
        }
        fields.push({
            ...field,
            name,
            displayName: capitalCase(name),
        });
        return;
    }

    const parent = fields.find((candidate) => candidate.name === name);
    if (!parent) throw new Error(`Lens target parent "${path.slice(0, -1).join(".")}" does not exist.`);
    const nested = structFields(parent.type);
    if (!nested) throw new Error(`Lens target path "${path.join(".")}" does not traverse a struct.`);
    insertField(nested, rest, field);
}

export function applyLensToObjectType(
    source: ObjectTypeDef,
    lens: Lens,
    options: ApplyObjectTypeLensOptions
): ObjectTypeDef {
    const target = structuredClone(source);
    target.name = options.name;
    target.displayName = options.displayName ?? capitalCase(options.name);
    target.pluralDisplayName = options.pluralDisplayName ?? `${target.displayName}s`;

    for (const operation of lens.operations) {
        switch (operation.kind) {
            case "move": {
                const field = removeField(target.properties, operation.value.from);
                insertField(target.properties, operation.value.to, field);
                if (
                    operation.value.from.length === 1 &&
                    operation.value.from[0] === target.primaryKey
                ) {
                    if (operation.value.to.length !== 1) {
                        throw new Error("An object primary key cannot be moved into a nested path.");
                    }
                    target.primaryKey = operation.value.to[0]!;
                }
                if (operation.value.from.length === 1 && operation.value.from[0] === target.title) {
                    target.title = operation.value.to.length === 1 ? operation.value.to[0] : undefined;
                }
                break;
            }
            case "select": {
                const selected = new Set(operation.value.properties);
                target.properties = target.properties.filter((property) => selected.has(property.name));
                if (!selected.has(target.primaryKey)) {
                    throw new Error(`Lens selection must retain primary key "${target.primaryKey}".`);
                }
                if (target.title && !selected.has(target.title)) target.title = undefined;
                break;
            }
        }
    }

    return target;
}

function cloneLensValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(cloneLensValue);
    }
    if (value && typeof value === "object") {
        const prototype = Object.getPrototypeOf(
            value
        ) as unknown;
        if (prototype === Object.prototype || prototype === null) {
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [key, cloneLensValue(entry)])
            );
        }
    }
    return value;
}

export function applyLensToObject<
    Source extends Record<string, unknown>,
    Target extends Record<string, unknown>,
>(source: Source, lens: Lens): Target {
    const target = cloneLensValue(source) as Record<string, unknown>;
    for (const operation of lens.operations) {
        switch (operation.kind) {
            case "move": {
                const value = get(target, operation.value.from) as unknown;
                unset(target, operation.value.from);
                set(target, operation.value.to, value);
                break;
            }
            case "select": {
                const selected = new Set(operation.value.properties);
                for (const property of Object.keys(target)) {
                    if (!selected.has(property)) delete target[property];
                }
                break;
            }
        }
    }
    return target as Target;
}

/**
 * Maps a target-model field path back to its source-model path so simple
 * target-side queries can be pushed through a lens. This is path provenance,
 * not a general inverse for values or schemas: selected-out data cannot be
 * reconstructed. A future lens query compiler can use this as its direct-path
 * primitive while handling computed/list operations, local evaluation, and
 * unsupported query rewrites at the expression or query-plan level.
 */
export function mapTargetPathToSourceWithLens(path: readonly string[], lens: Lens): string[] {
    let rewritten = [...path];
    for (const operation of [...lens.operations].reverse()) {
        switch (operation.kind) {
            case "move": {
                const target = operation.value.to;
                if (
                    rewritten.length >= target.length &&
                    target.every((segment, index) => rewritten[index] === segment)
                ) {
                    rewritten = [...operation.value.from, ...rewritten.slice(target.length)];
                }
                break;
            }
            case "select":
                if (rewritten[0] && !operation.value.properties.includes(rewritten[0])) {
                    throw new Error(`Lens target path "${path.join(".")}" is not selected.`);
                }
                break;
        }
    }
    return rewritten;
}
