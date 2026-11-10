import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createSecureServer } from "node:http2";

// Disposable benchmark transport only; keep certificates outside the repository.
const [listen, upstream, keyPath, certPath] = process.argv.slice(2);
const listenPort = Number(listen);
const upstreamPort = Number(upstream);
if (
    !keyPath ||
    !certPath ||
    ![listenPort, upstreamPort].every((port) => Number.isInteger(port) && port > 0 && port < 65_536)
)
    throw new Error("Pass LISTEN_PORT UPSTREAM_PORT KEY_PATH CERT_PATH.");

const stripHeaders = (headers) =>
    Object.fromEntries(
        Object.entries(headers).filter(
            ([key]) =>
                !key.startsWith(":") &&
                !["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"].includes(
                    key
                )
        )
    );
const server = createSecureServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    allowHTTP1: true,
});
server.on("request", (incoming, outgoing) => {
    const forwarded = request(
        {
            hostname: "127.0.0.1",
            port: upstreamPort,
            method: incoming.method,
            path: incoming.url,
            headers: { ...stripHeaders(incoming.headers), host: `localhost:${upstreamPort}` },
            // Each HTTP/2 stream needs an independent upstream HTTP/1 request.
            agent: false,
        },
        (response) => {
            outgoing.writeHead(response.statusCode ?? 502, stripHeaders(response.headers));
            response.pipe(outgoing);
        }
    );
    outgoing.on("close", () => forwarded.destroy());
    forwarded.on("error", (error) => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("Benchmark proxy upstream failed.");
        console.error(error.message);
    });
    incoming.pipe(forwarded);
});
server.on("sessionError", (error) => console.error(error.message));
server.listen(listenPort, "127.0.0.1", () =>
    console.log(`Benchmark HTTP/2 https://localhost:${listenPort} -> http://localhost:${upstreamPort}`)
);
