import { BackendError, BackendErrorKindSchema } from "@party-stack/ontology-backend";
import { o } from "@party-stack/ontology-spec";
import { QueryDocumentSchema } from "@party-stack/ontology-spec/effect";
import { digestBytesSync } from "@party-stack/ontology-storage/blobs";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import type { ActionMutatorRegistry } from "@party-stack/ontology-backend/actions";
import type { OntologyIR, QueryDocument, TypeDef } from "@party-stack/ontology-spec";

export interface PinWrite {
    readonly name: string;
    readonly query: QueryDocument;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly attachments?: "none" | "all";
}
export interface PinRecord<Inputs extends Readonly<Record<string, unknown>> = Record<string, unknown>> {
    readonly id: string;
    readonly name: string;
    /** Exact query and attachment policy; names group revisions, not overwrite them. */
    readonly definition: string;
    readonly query: QueryDocument;
    readonly inputs: Inputs;
    readonly attachments: "none" | "all";
    readonly generation: string;
    readonly ready: boolean;
    readonly error?: { readonly kind: BackendError["kind"]; readonly message: string };
}
export interface PinUpdate {
    readonly set?: readonly PinWrite[];
    readonly remove?: readonly string[];
    /** Clear every revision and input of this named family. */
    readonly clearName?: string;
}
const inputs = Schema.Record(Schema.String, Schema.Unknown);
export const PinWriteSchema = Schema.Struct({
    name: Schema.NonEmptyString,
    query: QueryDocumentSchema,
    inputs: Schema.optional(inputs),
    attachments: Schema.optional(Schema.Literals(["none", "all"])),
});
export const PinRecordSchema = Schema.Struct({
    ...PinWriteSchema.fields,
    id: Schema.String,
    definition: Schema.String,
    inputs,
    attachments: Schema.Literals(["none", "all"]),
    generation: Schema.String,
    ready: Schema.Boolean,
    error: Schema.optional(Schema.Struct({ kind: BackendErrorKindSchema, message: Schema.String })),
});
export const PinUpdateSchema = Schema.Struct({
    set: Schema.optional(Schema.Array(PinWriteSchema)),
    remove: Schema.optional(Schema.Array(Schema.String)),
    clearName: Schema.optional(Schema.NonEmptyString),
});

// The portable canonical encoding preserves scalar types and sorts object keys.
// Hash only that canonical representation, never insertion-order JSON.
const identity = Table.make<unknown>({ name: "pin-identity" });
const fingerprint = (value: unknown) => digestBytesSync(new TextEncoder().encode(identity.encode(value)));
export const pinDefinitionKey = (pin: Pick<PinWrite, "query" | "attachments">): string =>
    fingerprint({ query: pin.query, attachments: pin.attachments ?? "none" });
export const pinRecordKey = (pin: PinWrite): string =>
    fingerprint([pin.name, pinDefinitionKey(pin), pin.inputs ?? {}]);

const property = (name: string, type: TypeDef) => ({ name, displayName: name, type });
export const pinOntology: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Pin",
            displayName: "Download",
            pluralDisplayName: "Downloads",
            primaryKey: "id",
            icon: { name: "download" },
            color: "#76b6a3",
            properties: [
                ...["id", "name", "definition", "attachments", "generation"].map((name) =>
                    property(name, o.string({}))
                ),
                property("query", o.unknown({})),
                property("inputs", o.unknown({})),
                property("ready", o.boolean({})),
                property("error", o.optional({ type: o.unknown({}) })),
            ],
        },
    ],
    actionTypes: [
        {
            name: "updatePins",
            displayName: "Update downloads",
            logic: [],
            parameters: [property("change", o.unknown({}))],
        },
    ],
};

/** The same pure mutator runs in the owned control backend and the tab's normal
 * optimistic replica. Acquisition and byte IO never run inside this transaction. */
export const pinMutators = {
    updatePins: Effect.fnUntraced(function* (tx, invocation) {
        const change = yield* Schema.decodeUnknownEffect(PinUpdateSchema)(invocation.parameters.change).pipe(
            Effect.mapError(
                (cause) =>
                    new BackendError({
                        operation: "pins.update",
                        kind: "InvalidRequest",
                        retryable: false,
                        message: "Invalid download request.",
                        cause,
                    })
            )
        );
        const removed = new Set(change.remove);
        if (change.clearName !== undefined)
            for (const row of yield* tx.loadSubset("Pin", {
                where: { op: "eq", left: { _tag: "Field", path: ["name"] }, right: change.clearName },
            }))
                removed.add(String(row.key));
        for (const id of removed) yield* tx.delete("Pin", id);
        for (const write of change.set ?? []) {
            const id = pinRecordKey(write);
            const previous = yield* tx.get("Pin", id);
            if (previous && !previous.error) continue;
            yield* tx.put("Pin", {
                ...write,
                id,
                definition: pinDefinitionKey(write),
                inputs: write.inputs ?? {},
                attachments: write.attachments ?? "none",
                generation: invocation.id,
                ready: false,
            });
        }
    }),
} satisfies ActionMutatorRegistry;
