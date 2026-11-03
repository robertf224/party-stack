import { Attachments } from "@osdk/foundry.ontologies";
import { byteChunks, collectByteBlob, type ByteInput } from "@party-stack/ontology-storage/blobs";
import { Effect, Schema, Stream } from "effect";
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
        signal?: AbortSignal;
    }
): Promise<unknown> {
    const url = new URL(options.path, client.baseUrl.endsWith("/") ? client.baseUrl : `${client.baseUrl}/`);
    url.searchParams.set("filename", options.filename);
    if (options.preview) url.searchParams.set("preview", "true");
    const headers = new Headers({ "Content-Type": options.contentType, Accept: "application/json" });
    const stream = input instanceof Blob ? undefined : Stream.toReadableStream(byteChunks(input));
    const body = input instanceof Blob ? input : stream!;
    const init: RequestInit & { duplex?: "half" } = {
        method: options.method,
        headers,
        body,
        ...(stream ? { duplex: "half" as const } : {}),
        signal: options.signal,
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
        if (stream && !stream.locked) await stream.cancel().catch(() => undefined);
    }
}

export async function uploadFoundryMedia(
    client: OntologyClient,
    input: ByteInput,
    options: { filename: string; signal?: AbortSignal }
) {
    // Live browser/SharedWorker smoke test (2026-11-02): this endpoint accepted
    // a ReadableStream with application/octet-stream and no Content-Length (200).
    // Keep streaming here: the ordinary attachment endpoint behaved differently.
    // See specs/2026-10-19-effect-tables-replica/blob-future-work.md for the controls.
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
    options: { filename: string; rid?: string; signal?: AbortSignal }
) {
    // Live browser/SharedWorker smoke test (2026-11-02): streamed bodies failed
    // with 400 Default:InvalidArgument for both octet-stream and PNG Content-Type;
    // Blob and SDK controls succeeded. Media uploads above accepted streaming.
    // The docs do not state a length requirement, so revisit with a provider test.
    // For now use the SDK's Blob path, materializing only at this boundary within
    // collectByteBlob's size limit. Browser fetch forbids setting Content-Length
    // manually. Do not add a Blob/File capability to storage or RPC for this fix.
    const blob =
        input instanceof Blob
            ? input
            : await Effect.runPromise(collectByteBlob(input), { signal: options.signal });
    const signal = options.signal;
    const uploadClient = signal
        ? {
              ...client,
              fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                  client.fetch(input, {
                      ...init,
                      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                  }),
          }
        : client;
    return options.rid
        ? Attachments.uploadWithRid(uploadClient, options.rid, blob, {
              filename: options.filename,
              preview: true,
          })
        : Attachments.upload(uploadClient, blob, { filename: options.filename });
}
