import { constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import type { Plugin } from "vite";

const attributes = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]));
const trace = Schema.Struct({
    id: Schema.String,
    traceId: Schema.String,
    parentId: Schema.optional(Schema.String),
    name: Schema.String,
    startedAt: Schema.Finite,
    durationMs: Schema.Finite,
    outcome: Schema.Literals(["running", "success", "failure", "interrupted"]),
    attributes,
    events: Schema.optional(
        Schema.Array(Schema.Struct({ name: Schema.String, at: Schema.Finite, attributes }))
    ),
    eventCount: Schema.optional(Schema.Finite),
});
const decode = Schema.decodeUnknownSync(
    Schema.Struct({
        sessionId: Schema.String.check(
            Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        ),
        capturedAt: Schema.Finite,
        markers: Schema.Array(
            Schema.Struct({
                kind: Schema.String,
                stage: Schema.Literals(["start", "ready", "error"]),
                path: Schema.String,
                at: Schema.Finite,
                elapsedMs: Schema.optional(Schema.Finite),
                highlightMs: Schema.optional(Schema.Finite),
            })
        ),
        tab: Schema.Array(trace),
        parent: Schema.Array(trace),
    })
);

/** Temporary development recorder. The endpoint cannot select a filesystem path. */
export function userTraceRecorder(): Plugin {
    return {
        name: "notes-local-user-trace",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                if (request.url?.split("?")[0] !== "/__notes_trace") return next();
                void (async () => {
                    const origin = new URL(String(request.headers.origin));
                    const referrer = new URL(String(request.headers.referer));
                    if (
                        request.method !== "POST" ||
                        !request.headers["content-type"]?.startsWith("application/json") ||
                        request.headers["sec-fetch-site"] !== "same-origin" ||
                        origin.origin !== referrer.origin ||
                        !(
                            origin.hostname === "localhost" ||
                            origin.hostname === "127.0.0.1" ||
                            origin.hostname.endsWith(".localhost")
                        )
                    ) {
                        response.statusCode = 403;
                        response.end();
                        return;
                    }
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    for await (const chunk of request) {
                        const buffer = Buffer.from(chunk);
                        bytes += buffer.length;
                        if (bytes > 2 * 1024 * 1024) {
                            response.statusCode = 413;
                            response.end();
                            return;
                        }
                        chunks.push(buffer);
                    }
                    const payload = decode(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                    await writeFile(
                        `/tmp/party-user-notes-trace-${payload.sessionId}.json`,
                        JSON.stringify(payload),
                        {
                            flag:
                                constants.O_CREAT |
                                constants.O_WRONLY |
                                constants.O_TRUNC |
                                constants.O_NOFOLLOW,
                            mode: 0o600,
                        }
                    );
                    response.statusCode = 204;
                    response.end();
                })().catch(() => {
                    response.statusCode = 400;
                    response.end();
                });
            });
        },
    };
}
