import { createFoundryFetch, createOntologyClient } from "@party-stack/foundry-client";
import { Effect, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { uploadFoundryAttachment, uploadFoundryMedia } from "./uploads.js";
import type { OntologyClient } from "@party-stack/foundry-client";

const reference = {
    mimeType: "audio/webm",
    reference: {
        type: "mediaSetViewItem",
        mediaSetViewItem: { mediaSetRid: "set", mediaSetViewRid: "view", mediaItemRid: "item" },
    },
};

test("uploads unknown-length media as a binary stream through the authenticated fetch boundary", async () => {
    let generated = 0;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.method).toBe("PUT");
        expect(new URL(request.url).pathname).toBe("/api/v2/mediasets/media/upload");
        expect(new URL(request.url).searchParams.get("filename")).toBe("voice recording.webm");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/octet-stream");
        expect(request.headers.has("content-length")).toBe(false);
        expect(generated).toBeLessThan(100);
        const bytes = new Uint8Array(await request.arrayBuffer());
        expect(bytes.length).toBe(100 * 4096);
        return Response.json(reference);
    });
    const client = {
        baseUrl: "https://foundry.example/",
        fetch: createFoundryFetch({
            baseUrl: "https://foundry.example/",
            tokenProvider: () => Promise.resolve("test-token"),
            fetch: transport,
        }),
    } as OntologyClient;
    const stream = Stream.fromIterable(
        Array.from({ length: 100 }, () => 4096),
        { chunkSize: 1 }
    ).pipe(
        Stream.map((length) => {
            generated++;
            return new Uint8Array(length);
        })
    );
    expect(
        await uploadFoundryMedia(client, { type: "audio/webm", stream }, { filename: "voice recording.webm" })
    ).toEqual(reference);
    expect(generated).toBe(100);
    expect(transport).toHaveBeenCalledOnce();
});

test("preserves structured provider failure details for standard adapter classification", async () => {
    const client = {
        baseUrl: "https://foundry.example",
        fetch: vi.fn(() =>
            Promise.resolve(
                Response.json(
                    {
                        errorCode: "INVALID_ARGUMENT",
                        errorName: "InvalidMediaItem",
                        parameters: { reason: "invalid" },
                    },
                    { status: 400 }
                )
            )
        ),
    } as unknown as OntologyClient;
    await expect(uploadFoundryMedia(client, new Blob(["bytes"]), { filename: "file" })).rejects.toMatchObject(
        { statusCode: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidMediaItem" }
    );
});

test("preserves HTTP status when an upload fails with a non-JSON proxy response", async () => {
    const client = {
        baseUrl: "https://foundry.example",
        fetch: vi.fn(() => Promise.resolve(new Response("Service unavailable", { status: 503 }))),
    } as unknown as OntologyClient;
    await expect(uploadFoundryMedia(client, new Blob(["bytes"]), { filename: "file" })).rejects.toMatchObject(
        {
            statusCode: 503,
            message: "Foundry upload failed.",
        }
    );
});

test("attachment SDK receives a completed Blob and preserves its size, type and filename", async () => {
    let generated = 0;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(generated).toBe(2);
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/api/v2/ontologies/attachments/upload");
        expect(new URL(request.url).searchParams.get("filename")).toBe("image.png");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("image/png");
        expect(request.headers.get("content-length")).toBe("6");
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
        return Response.json({ rid: "remote-attachment" });
    });
    const client = createOntologyClient({
        baseUrl: "https://foundry.example/",
        ontologyRid: "ontology",
        tokenProvider: () => Promise.resolve("test-token"),
        fetch: createFoundryFetch({
            baseUrl: "https://foundry.example/",
            tokenProvider: () => Promise.resolve("test-token"),
            fetch: transport,
        }),
    });
    const result = await uploadFoundryAttachment(
        client,
        {
            type: "image/png",
            size: 6,
            stream: Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])).pipe(
                Stream.tap(() =>
                    Effect.sync(() => {
                        generated++;
                    })
                )
            ),
        },
        { filename: "image.png" }
    );
    expect(result.rid).toBe("remote-attachment");
    expect(transport).toHaveBeenCalledOnce();
});

test("existing Blob inputs are sent directly without rebuilding or consuming a stream", async () => {
    const blob = new Blob(["original"], { type: "image/png" });
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.body).toBe(blob);
        return Response.json({ rid: "remote-attachment" });
    });
    const client = createOntologyClient({
        baseUrl: "https://foundry.example/",
        ontologyRid: "ontology",
        tokenProvider: () => Promise.resolve("test-token"),
        fetch: transport,
    });
    await uploadFoundryAttachment(client, blob, { filename: "image.png" });
});

test("unknown-length attachments are completed before sending a size-known body", async () => {
    let emitted = 0;
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
        expect(emitted).toBe(2);
        expect(init?.body).toBeInstanceOf(Blob);
        expect((init!.body as Blob).size).toBe(6);
        return Response.json({ rid: "remote-attachment" });
    });
    const client = createOntologyClient({
        baseUrl: "https://foundry.example/",
        ontologyRid: "ontology",
        tokenProvider: () => Promise.resolve("test-token"),
        fetch: transport,
    });
    await uploadFoundryAttachment(
        client,
        {
            type: "text/plain",
            stream: Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])).pipe(
                Stream.tap(() =>
                    Effect.sync(() => {
                        emitted++;
                    })
                )
            ),
        },
        { filename: "file.txt" }
    );
});

test("cancelling size discovery stops the source and never starts the HTTP upload", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
        started = resolve;
    });
    let closed = false;
    const transport = vi.fn<typeof fetch>();
    const client = createOntologyClient({
        baseUrl: "https://foundry.example/",
        ontologyRid: "ontology",
        tokenProvider: () => Promise.resolve("test-token"),
        fetch: transport,
    });
    const pending = uploadFoundryAttachment(
        client,
        {
            type: "text/plain",
            stream: Stream.concat(
                Stream.fromEffect(
                    Effect.sync(() => {
                        started();
                        return new Uint8Array([1]);
                    })
                ),
                Stream.never
            ).pipe(
                Stream.ensuring(
                    Effect.sync(() => {
                        closed = true;
                    })
                )
            ),
        },
        { filename: "file.txt", signal: controller.signal }
    );
    await ready;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(closed).toBe(true);
    expect(transport).not.toHaveBeenCalled();
});

test("ordinary attachment buffering is bounded before the SDK starts its request", async () => {
    const transport = vi.fn<typeof fetch>();
    const client = createOntologyClient({
        baseUrl: "https://foundry.example/",
        ontologyRid: "ontology",
        tokenProvider: () => Promise.resolve("test-token"),
        fetch: transport,
    });
    await expect(
        uploadFoundryAttachment(
            client,
            {
                type: "application/octet-stream",
                size: 65 * 1024 * 1024,
                stream: Stream.never,
            },
            { filename: "large.bin" }
        )
    ).rejects.toBeDefined();
    expect(transport).not.toHaveBeenCalled();
});

test("attachment SDK failures retain provider details for adapter classification", async () => {
    const client = createOntologyClient({
        baseUrl: "https://foundry.example/",
        ontologyRid: "ontology",
        tokenProvider: () => Promise.resolve("test-token"),
        fetch: async () =>
            Response.json(
                {
                    errorCode: "INVALID_ARGUMENT",
                    errorName: "InvalidAttachment",
                    parameters: { reason: "invalid" },
                },
                { status: 400 }
            ),
    });
    await expect(
        uploadFoundryAttachment(client, new Blob(["bytes"]), { filename: "file" })
    ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: "INVALID_ARGUMENT",
        errorName: "InvalidAttachment",
    });
});
