import { OntologiesV2 } from "@osdk/foundry.ontologies";
import { toWebEgress } from "@party-stack/connect";
import { createClient } from "@party-stack/foundry-client";
import { BackendError, classifyBackendFailure, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset, objectSubset } from "@party-stack/ontology-backend/subset";
import { defineOntology, o } from "@party-stack/ontology-spec";
import { Effect, Redacted, Schema } from "effect";
import { foundryContext } from "./context.js";
import type { ConnectionEgress } from "@party-stack/connect";
import type { Infer } from "@party-stack/ontology-spec";
import type { ObjectSubset } from "@party-stack/ontology-spec/query";

/** Account-visible inventory, separate from one selected ontology's type metadata. */
export const foundryPlatformOntology = defineOntology({
    types: [],
    context: foundryContext,
    objectTypes: [
        {
            name: "Ontology",
            displayName: "Ontology",
            pluralDisplayName: "Ontologies",
            primaryKey: "id",
            title: "displayName",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "rid", displayName: "RID", type: o.string({}) },
                { name: "apiName", displayName: "API name", type: o.string({}) },
                { name: "displayName", displayName: "Name", type: o.string({}) },
                { name: "description", displayName: "Description", type: o.string({}) },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
});

export type FoundryPlatformOntology = Infer<typeof foundryPlatformOntology>;

const inventory = Schema.Struct({
    data: Schema.Array(
        Schema.Struct({
            rid: Schema.NonEmptyString,
            apiName: Schema.NonEmptyString,
            displayName: Schema.String,
            description: Schema.String,
        })
    ),
});
const unsupported = (operation: string) =>
    Effect.fail(
        new BackendError({
            operation,
            kind: "NotImplemented",
            retryable: false,
            message: "Foundry platform inventory is read-only.",
        })
    );

/** Uses the selected account's authenticated egress; it stores no credentials or rows. */
export const makeFoundryPlatformBackend = Effect.fnUntraced(function* (options: {
    readonly baseUrl: string;
    readonly egress: ConnectionEgress;
}) {
    const web = yield* toWebEgress(options.egress);
    const client = createClient({ baseUrl: options.baseUrl, fetch: web.fetch });
    return makeOntologyBackend({
        ir: foundryPlatformOntology,
        name: "foundry-platform",
        sourceId: `foundry-platform:${client.baseUrl}`,
        supportsIdempotency: false,
        refresh: () => ({ pollIntervalMs: false }),
        applyAction: () => unsupported("foundry.platform.applyAction"),
        queryFunction: () => unsupported("foundry.platform.queryFunction"),
        loadSubset: Effect.fn("FoundryPlatform.loadSubset")(function* (request: ObjectSubset) {
            yield* compileObjectSubset(foundryPlatformOntology, request);
            const response = yield* Effect.tryPromise({
                try: (signal) =>
                    OntologiesV2.list({
                        ...client,
                        fetch: (input, init) =>
                            client.fetch(input, {
                                ...init,
                                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                            }),
                    }),
                catch: (cause) => classifyBackendFailure("foundry.platform.listOntologies", cause),
            });
            const { data: values } = yield* Schema.decodeUnknownEffect(inventory)(response).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "foundry.platform.decode",
                            kind: "InvalidResponse",
                            retryable: false,
                            message: "Foundry returned invalid ontology inventory.",
                            cause: Redacted.make(cause),
                        })
                )
            );
            return {
                rows: values.map((value) => ({ key: value.rid, value: { id: value.rid, ...value } })),
                complete: true,
                fulfilledSubset: objectSubset("Ontology"),
                fetchedRows: values.length,
            };
        }),
    });
});
