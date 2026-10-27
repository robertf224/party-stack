import { createServer } from "node:http";
import { createFoundryFetch } from "@party-stack/foundry-client";
import { Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { uploadFoundryAttachment, uploadFoundryMedia } from "./streamingMedia.js";
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

test("ordinary attachments reach an HTTP server before an unknown-length producer finishes", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let total = 0;
    let ended = false;
    let path: string | undefined;
    let authorization: string | undefined;
    let contentType: string | undefined;
    const server = createServer(async (request, response) => {
        path = request.url;
        authorization = request.headers.authorization;
        contentType = request.headers["content-type"];
        for await (const chunk of request) {
            total += (chunk as Buffer).length;
        }
        ended = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ rid: "streamed-attachment" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind.");
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const client = {
        baseUrl,
        fetch: createFoundryFetch({ baseUrl, tokenProvider: () => Promise.resolve("test-token") }),
    } as OntologyClient;
    const stream = Stream.fromAsyncIterable(
        (async function* () {
            yield new Uint8Array(128 * 1024);
            await finished;
            yield new Uint8Array([1, 2, 3]);
        })(),
        (cause) => cause
    );
    const upload = uploadFoundryAttachment(
        client,
        { type: "audio/webm", stream },
        { filename: "voice.webm" }
    );
    void upload.catch(() => undefined);
    try {
        await expect.poll(() => total).toBeGreaterThan(0);
        expect(ended).toBe(false);
        finish();
        await expect(upload).resolves.toEqual({ rid: "streamed-attachment" });
        expect(total).toBe(128 * 1024 + 3);
        expect(path).toBe("/api/v2/ontologies/attachments/upload?filename=voice.webm");
        expect(authorization).toBe("Bearer test-token");
        expect(contentType).toBe("audio/webm");
    } finally {
        finish();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
        await upload.catch(() => undefined);
    }
});
