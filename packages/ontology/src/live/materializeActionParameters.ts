import { invariant } from "@bobbyfidz/panic";
import type { BlobManager } from "@party-stack/blobs";
import { resolveType } from "../utils/types.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type {
    AttachmentTypeDef,
    ListTypeDef,
    MapTypeDef,
    OntologyIR,
    StructTypeDef,
    TypeDef,
} from "../ir/index.js";
import type { attachment } from "../utils/values.js";

interface MaterializeValueOptions {
    ir: OntologyIR;
    adapter: OntologyAdapter;
    blobManager?: BlobManager;
    type: TypeDef;
    value: unknown;
}

async function materializeAttachment(opts: MaterializeValueOptions, type: AttachmentTypeDef) {
    const materializeAttachment = opts.adapter.attachments?.materializeAttachment;
    if (!materializeAttachment) {
        return opts.value;
    }
    const blobManager = opts.blobManager;
    invariant(blobManager, "Missing required BlobManager for materializing attachments.");
    const attachment = opts.value as attachment;

    await blobManager.withUploadTracking(attachment.id, (blob) =>
        materializeAttachment(attachment, blob, { target: type })
    );
    return opts.value;
}

function materializeList(opts: MaterializeValueOptions, type: ListTypeDef) {
    return Promise.all(
        (opts.value as unknown[]).map((value) =>
            materializeValue({
                ...opts,
                type: type.elementType,
                value,
            })
        )
    );
}

async function materializeMap(opts: MaterializeValueOptions, type: MapTypeDef) {
    const entries = await Promise.all(
        Object.entries(opts.value as Record<string, unknown>).map(
            async ([key, value]): Promise<[string, unknown]> => [
                key,
                await materializeValue({
                    ...opts,
                    type: type.valueType,
                    value,
                }),
            ]
        )
    );
    return Object.fromEntries(entries);
}

async function materializeStruct(opts: MaterializeValueOptions, type: StructTypeDef) {
    const fieldsByName = new Map(type.fields.map((field) => [field.name, field.type]));
    const entries = await Promise.all(
        Object.entries(opts.value as Record<string, unknown>).map(
            async ([key, value]): Promise<[string, unknown]> => {
                const fieldType = fieldsByName.get(key);
                return [
                    key,
                    fieldType
                        ? await materializeValue({
                              ...opts,
                              type: fieldType,
                              value,
                          })
                        : value,
                ];
            }
        )
    );
    return Object.fromEntries(entries);
}

async function materializeValue(opts: MaterializeValueOptions): Promise<unknown> {
    const type = resolveType(opts.ir, opts.type);
    switch (type.kind) {
        case "attachment":
            return materializeAttachment(opts, type.value);
        case "optional":
            if (opts.value === undefined || opts.value === null) {
                return opts.value;
            }
            return materializeValue({
                ...opts,
                type: type.value.type,
            });
        case "list":
            return materializeList(opts, type.value);
        case "map":
            return materializeMap(opts, type.value);
        case "struct":
            return materializeStruct(opts, type.value);
        default:
            return opts.value;
    }
}

export async function materializeActionParameters(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    adapter: OntologyAdapter;
    blobManager?: BlobManager;
}): Promise<Record<string, unknown>> {
    const action = opts.ir.actionTypes.find((candidate) => candidate.name === opts.actionTypeName)!;
    const materializedEntries = await Promise.all(
        action.parameters.map(
            async (parameter): Promise<[string, unknown]> => [
                parameter.name,
                await materializeValue({
                    ir: opts.ir,
                    adapter: opts.adapter,
                    blobManager: opts.blobManager,
                    type: parameter.type,
                    value: opts.parameters[parameter.name],
                }),
            ]
        )
    );
    return Object.fromEntries(materializedEntries);
}
