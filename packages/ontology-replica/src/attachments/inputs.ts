import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { byteSource, digestBytes } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Predicate, RcMap, Semaphore, Stream } from "effect";
import { invalidAttachment, validateAttachmentSource } from "./validate.js";
import type { BlobManagerService } from "./manager.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

/** Native input boundary only. Binary values become stable handles before intent
 * reaches the journal, optimistic mutator, parent protocol or provider adapter.
 */
export const makeActionAttachmentInputs = Effect.fnUntraced(function* (options: {
    ir: OntologyIR;
    manager?: BlobManagerService;
}) {
    const locks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
    const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(Effect.mapError((cause) => classifyBackendFailure("attachment.input", cause)));
    const codec = Table.make<ActionRequest>({ name: "action-input" });
    return <A>(
        request: ActionRequest,
        submit: (normalized: ActionRequest) => Effect.Effect<A, BackendError>
    ) =>
        Effect.scoped(
            Effect.gen(function* () {
                const action = options.ir.actionTypes.find((action) => action.name === request.name);
                if (!action) return yield* submit(request);
                const captured = { ...request, parameters: { ...request.parameters } };
                const files: { id: string; file: Blob; path: readonly (string | number)[] }[] = [];
                const replacements = new Map<string, { id: string; type: string }>();
                const visit = Effect.fnUntraced(function* (
                    definition: TypeDef,
                    value: unknown,
                    path: readonly (string | number)[]
                ): Effect.fn.Return<unknown, BackendError> {
                    if (value === null || value === undefined) return value;
                    const type = yield* Effect.try({
                        try: () => resolveType(options.ir, definition),
                        catch: () => invalidAttachment("Invalid attachment parameter type."),
                    });
                    switch (type.kind) {
                        case "attachment": {
                            if (!(value instanceof Blob))
                                return replacements.get(JSON.stringify(path)) ?? value;
                            if (!options.manager)
                                return yield* new BackendError({
                                    operation: "attachment.input",
                                    kind: "NotImplemented",
                                    retryable: false,
                                    message: "File arguments require local attachment storage.",
                                    actionOutcome: "not-committed",
                                });
                            const source = byteSource(value);
                            yield* validateAttachmentSource(source, type.value);
                            // No byte IO while traversing the mutable caller input.
                            files.push({ id: "pending", file: value, path });
                            return { id: "pending", type: source.type };
                        }
                        case "optional":
                            return yield* visit(type.value.type, value, path);
                        case "list":
                            return Array.isArray(value)
                                ? yield* Effect.forEach(value, (item, index) =>
                                      visit(type.value.elementType, item, [...path, index])
                                  )
                                : value;
                        case "map":
                            return Predicate.isObject(value)
                                ? Object.fromEntries(
                                      yield* Effect.forEach(Object.entries(value), ([key, item]) =>
                                          Effect.map(
                                              visit(type.value.valueType, item, [...path, key]),
                                              (result) => [key, result]
                                          )
                                      )
                                  )
                                : value;
                        case "struct": {
                            if (!Predicate.isObject(value)) return value;
                            const result = { ...value };
                            for (const field of type.value.fields)
                                if (Object.hasOwn(value, field.name))
                                    result[field.name] = yield* visit(field.type, value[field.name], [
                                        ...path,
                                        field.name,
                                    ]);
                            return result;
                        }
                        case "union": {
                            if (!Predicate.isObject(value)) return value;
                            const variant = type.value.variants.find(
                                (variant) => variant.name === value.kind
                            );
                            return variant
                                ? {
                                      ...value,
                                      value: yield* visit(variant.type, value.value, [...path, "value"]),
                                  }
                                : value;
                        }
                        case "result":
                            return Predicate.isObject(value) && (value.kind === "ok" || value.kind === "err")
                                ? {
                                      ...value,
                                      value: yield* visit(
                                          value.kind === "ok" ? type.value.okType : type.value.errType,
                                          value.value,
                                          [...path, "value"]
                                      ),
                                  }
                                : value;
                        default:
                            return value;
                    }
                });
                const parameters = { ...captured.parameters };
                for (const parameter of action.parameters)
                    if (Object.hasOwn(parameters, parameter.name))
                        parameters[parameter.name] = yield* visit(
                            parameter.type,
                            parameters[parameter.name],
                            [parameter.name]
                        );
                if (!files.length) return yield* submit(request);
                // Reject stray binaries/cycles before writing any bytes. Canonical action
                // validation/default resolution still belongs to the enqueue transaction.
                const normalized = yield* Effect.try({
                    try: () => codec.decode(codec.encode({ ...captured, parameters })),
                    catch: () =>
                        invalidAttachment(
                            "Invalid action parameters; files require declared attachment positions."
                        ),
                });
                // Freeze ordinary domain values before hashing/byte IO can yield.
                for (const file of files) {
                    const source = byteSource(file.file);
                    const identity = new TextEncoder().encode(
                        JSON.stringify([normalized.id, normalized.name, file.path, source.type, source.name])
                    );
                    const hash = yield* boundary(
                        digestBytes({
                            ...source,
                            stream: Stream.concat(Stream.make(identity), source.stream),
                        })
                    );
                    file.id = `action-attachment:${hash}`;
                    replacements.set(JSON.stringify(file.path), { id: file.id, type: source.type });
                }
                for (const parameter of action.parameters)
                    if (Object.hasOwn(normalized.parameters, parameter.name))
                        normalized.parameters[parameter.name] = yield* visit(
                            parameter.type,
                            normalized.parameters[parameter.name],
                            [parameter.name]
                        );
                const lock = yield* RcMap.get(locks, normalized.id);
                return yield* lock.withPermit(
                    Effect.gen(function* () {
                        const manager = options.manager!;
                        for (const { id, file } of files) {
                            const existing = yield* boundary(manager.storage.metadata(id));
                            if (!existing?.byteKey && !existing?.remoteId) yield* manager.stage(id, file);
                            // Existing scoped reads supply crash-recoverable process roots.
                            // They protect staged bytes until the outbox acquires durable roots.
                            if (!existing?.remoteId) yield* boundary(manager.storage.readScoped(id));
                        }
                        return yield* submit(normalized);
                    })
                );
            })
        ).pipe(Effect.withSpan("Replica.prepareActionInputs"));
});
