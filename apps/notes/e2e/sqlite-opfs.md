# SQLite OPFS experiment

This compares the existing IndexedDB worker cache with Effect's SQLite WASM
client and the normal SQL Tables adapter. Notes' queries, fragments, memory tab
replica, RPC transport and HTTP backend are unchanged.

Chrome156 exposes synchronous OPFS access only in dedicated workers. Its
SharedWorker also cannot construct a dedicated Worker. The experimental harness
therefore keeps a separate host tab alive; that tab owns the dedicated SQLite
worker and transfers its MessagePort to the experimental ontology SharedWorker.
The host must outlive every Notes tab. Closing it interrupts database access.
This is a benchmark topology, not a replacement for normal Notes persistence.

`sqlite-host.ts` performs the one-time capability handoff. Afterward, app tabs use
the existing ontology RPC protocol. The harness redirects their SharedWorker
constructor to the experimental entry. Both entries use `src/notes/notes-server.ts`.
One SQLite client serves all runtime partitions with stable SQL prefixes; blobs,
keys and network capabilities still come from WebRuntime. Forget drops that
partition's SQL tables and its browser keys/blobs.

Start a separate development preview from this directory's app root:

```sh
VITE_NOTES_STORAGE=sqlite-opfs PORTLESS=0 pnpm exec vp dev --host 127.0.0.1 --port 5175 --strictPort
```

The Vite flag configures WASM dependency loading. It does not switch the normal
app's storage. Put this preview behind an HTTPS proxy with HTTP/2 support. For a
disposable local comparison, create an ephemeral certificate outside the repo
and start the benchmark-only proxy in another terminal:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/notes-benchmark-key.pem -out /tmp/notes-benchmark-cert.pem \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -days 1
node e2e/http2-benchmark-proxy.mjs 5177 5175 \
  /tmp/notes-benchmark-key.pem /tmp/notes-benchmark-cert.pem
```

The harness owns the SQL host and selects its worker:

```sh
PARTY_SQLITE_HOST=1 PARTY_BROWSER_CHANNEL=chrome PARTY_DOWNLOAD_OFFLINE=1 \
  PARTY_IGNORE_HTTPS_ERRORS=1 node e2e/navigation-latency.mjs https://localhost:5177
```

The ordinary HTTP RPC watches are long-lived streams. HTTP/1 can exhaust the
browser's per-origin connection limit and block a new watch before its response
headers arrive. The experiment reproduced that stall on plain localhost;
HTTP/2 allowed the same offline download to complete. Keep the transport equal
when comparing storage backends. `PARTY_IGNORE_HTTPS_ERRORS=1` is available only
for disposable benchmark contexts using an ephemeral self-signed certificate.

Add `PARTY_FULL_TRASH_IMPORT=1` to measure the full downloaded Trash query in a
fresh memory tab. It verifies the row count and records a post-paint SHA256 of
the result, without saving note contents. Omit `PARTY_SQLITE_HOST` for IndexedDB.
Archive `/tmp/party-navigation-*` between runs.

Use disposable browser contexts. Setup reads server data and downloads it through
the ordinary offline pin; it does not seed rows or alter server notes. Record the
one-time SQL host startup separately from warm cache query latency. Keep builds,
other browser probes and CPU benchmarks outside each timing window.

`PARTY_SQLITE_TRACE=1` enables the experimental worker's bounded diagnostic trace
capture. Leave it off for timing comparisons; the ordinary app tracing hooks are
still available through the navigation harness. The experimental worker uses the
same `TraceRecording` mode as the normal worker (`buffer` in development, `live`
in production).

The measured experiment returned the same 1,447 Trash rows and canonical hash as
IndexedDB. SQLite was slower on this app path; the result does not justify
changing the normal storage backend. Host/WASM startup, the extra worker hop and
the dedicated host-tab lifetime must be accounted for separately.
