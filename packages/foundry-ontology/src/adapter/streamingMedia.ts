import { byteSource, byteChunks, type ByteInput } from "@party-stack/ontology-storage/blobs";
import { Schema, Stream } from "effect";
import type { OntologyClient } from "@party-stack/foundry-client";

const MediaReference = Schema.Struct({
    mimeType: Schema.String,
    reference: Schema.Struct({
        type: Schema.Literal("mediaSetViewItem"),
        mediaSetViewItem: Schema.Struct({
            mediaSetRid: Schema.String,
            mediaSetViewRid: Schema.String,
            mediaItemRid: Schema.String,
            token: Schema.optional(Schema.String),
        }),
    }),
});
const ApiFailure = Schema.Struct({
    errorName: Schema.optional(Schema.String),
    errorCode: Schema.optional(Schema.String),
    errorInstanceId: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Unknown),
});

/** The generated SDK only accepts Blob and JSON-encodes other bodies. Use the same authenticated fetch. */
async function uploadBinary(
    client: OntologyClient,
    input: ByteInput,
    options: {
        path: string;
        method: "POST" | "PUT";
        filename: string;
        contentType: string;
        preview?: boolean;
    }
): Promise<unknown> {
    const url = new URL(options.path, client.baseUrl.endsWith("/") ? client.baseUrl : `${client.baseUrl}/`);
    url.searchParams.set("filename", options.filename);
    if (options.preview) url.searchParams.set("preview", "true");
    const body = Stream.toReadableStream(byteChunks(input));
    const init: RequestInit & { duplex: "half" } = {
        method: options.method,
        headers: { "Content-Type": options.contentType, Accept: "application/json" },
        body,
        duplex: "half",
    };
    try {
        const response = await client.fetch(url, init);
        if (!response.ok) {
            const details = Schema.decodeUnknownOption(ApiFailure)(
                await response.json().catch(() => undefined)
            );
            throw Object.assign(
                new Error("Foundry upload failed."),
                details._tag === "Some" ? details.value : {},
                {
                    statusCode: response.status,
                }
            );
        }
        return await response.json();
    } finally {
        if (!body.locked) await body.cancel().catch(() => undefined);
    }
}

export async function uploadFoundryMedia(
    client: OntologyClient,
    input: ByteInput,
    options: { filename: string }
) {
    return Schema.decodeUnknownSync(MediaReference)(
        await uploadBinary(client, input, {
            ...options,
            path: "api/v2/mediasets/media/upload",
            method: "PUT",
            contentType: "application/octet-stream",
        })
    );
}

export async function uploadFoundryAttachment(
    client: OntologyClient,
    input: ByteInput,
    options: { filename: string; rid?: string }
) {
    return Schema.decodeUnknownSync(Schema.Struct({ rid: Schema.NonEmptyString }))(
        await uploadBinary(client, input, {
            filename: options.filename,
            path: options.rid
                ? `api/v2/ontologies/attachments/upload/${encodeURIComponent(options.rid)}`
                : "api/v2/ontologies/attachments/upload",
            method: "POST",
            contentType: byteSource(input).type || "application/octet-stream",
            preview: Boolean(options.rid),
        })
    );
}
