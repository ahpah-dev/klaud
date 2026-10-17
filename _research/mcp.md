# MCP as Claude Code implements it — wire-level research notes

Compiled for a zero-dependency (Node builtins only) parity implementation.

**Revision date of the protocol used as "latest stable": `2026-07-28`.** The MCP site's
version selector labels `2026-07-28` "(latest)"; a `draft` revision also exists.
Prior revisions still in the wild: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.

Everything below is either quoted/paraphrased from a page listed in **Sources fetched**
or explicitly marked **[UNVERIFIED]**, **[INFERENCE]**, or **[GAP]**. Where the docs are
silent I say so rather than guessing.

---

## Sources fetched

| # | URL | Result |
|---|---|---|
| 1 | `https://code.claude.com/docs/en/mcp.md` | **OK but truncated.** Fetch returned HTTP 200; the tool cut the page at ~50 KB, ending mid-sentence inside "MCP output limits and warnings". Sections after that point ("Use MCP resources", "Use MCP prompts as commands", elicitation, tool metadata) were **not** retrieved from this URL. |
| 2 | `https://code.claude.com/docs/en/mcp-servers.md` | **OK but truncated identically.** Same content as #1 (duplicate route). |
| 3 | `https://code.claude.com/docs/en/mcp-quickstart.md` | **OK, complete.** |
| 4 | `https://code.claude.com/docs/en/agent-sdk/mcp.md` | **OK, complete.** |
| 5 | `https://code.claude.com/docs/en/permissions.md` | **OK, tail truncated** (32 KB omitted). The MCP-relevant parts (tool-name globs, `mcp__*`) were retrieved. |
| 6 | `https://code.claude.com/docs/en/commands.md` | **OK, complete.** |
| 7 | `https://code.claude.com/docs/llms.txt` | **OK, partially truncated**; used as the docs index. |
| 8 | `https://web.archive.org/web/20260208143615id_/https://code.claude.com/docs/en/mcp.md` | **OK, complete.** Wayback capture of the official page dated **2026-02-08**. This supplied the sections the live fetch truncated: "Use MCP resources", "Use MCP prompts as commands", "Scale with MCP Tool Search", "Managed MCP configuration". Older revision than #1 — treat version-specific claims from it as of Feb 2026. |
| 9 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md` | **OK, complete.** |
| 10 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md` | **OK, complete.** (`.../basic/lifecycle.md` for this revision **redirects here** — there is no lifecycle page in 2026-07-28.) |
| 11 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md` | **OK, complete.** |
| 12 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md` | **OK, complete.** |
| 13 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md` | **OK, complete.** |
| 14 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md` | **OK, complete.** |
| 15 | `https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress.md` | **OK, complete.** |
| 16 | `https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md` | **OK, complete.** |
| 17 | `https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md` | **OK, complete.** |
| 18 | `https://modelcontextprotocol.io/specification/2026-07-28/server/prompts.md` | **OK, complete.** |
| 19 | `https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md` | **OK, complete.** |
| 20 | `https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination.md` | **OK, complete.** |
| 21 | `https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging.md` | **OK, complete.** |
| 22 | `https://modelcontextprotocol.io/specification/2026-07-28/changelog.md` | **OK, complete.** |
| 23 | `https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle.md` | **OK, complete.** This is the authoritative source for the legacy `initialize` handshake. |
| 24 | `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.md` | **OK, complete.** |
| 25 | `https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md` | **OK, complete.** |
| 26 | `https://modelcontextprotocol.io/specification/2025-06-18/server/tools.md` | **OK, complete.** |
| 27 | `https://modelcontextprotocol.io/specification/2025-03-26/server/tools.md` | **OK, complete.** |
| 28 | `https://modelcontextprotocol.io/specification/2024-11-05/basic/transports.md` | **OK, complete.** |
| 29 | `https://modelcontextprotocol.io/specification/2026-07-28/schema.md` | **FAILED (partial).** Truncated at ~50 KB; the captured portion covered JSON-RPC types, Common Types, and part of Content. **`ToolAnnotations` was not reached** — grep for `readOnlyHint` in the captured text returned nothing. |
| 30 | `https://modelcontextprotocol.io/community/interest-groups/tool-annotations.md` | **OK, complete.** Used only to confirm the four annotation field names. |
| 31 | `https://modelcontextprotocol.io/` | **OK** (redirects to `/docs/2026-07-28/getting-started/intro`). |
| 32 | `https://raw.githubusercontent.com/ericbuess/claude-code-docs/main/docs/mcp.md` | **Third-party mirror, OK but truncated** like the official page. Used once, to read the end of the "error results" bullet. Not treated as authoritative for anything else. |
| 33 | `https://modelcontextprotocol.io/llms.txt` | **OK, partially truncated.** Used to find spec page paths. |

Not fetched / could not be fetched: the live-page tail of #1 beyond "MCP output limits";
`ToolAnnotations` defaults from the schema page. These are flagged inline.

---

## 1. The wire protocol

### 1.1 JSON-RPC 2.0 base shapes

All MCP messages **MUST** follow JSON-RPC 2.0 and **MUST** be UTF-8 encoded
(`basic/index`, `basic/transports`). The four message shapes, verbatim from
`2026-07-28/basic/index`:

```ts
// Request — "MUST include a string or integer ID. Unlike base JSON-RPC, the ID MUST NOT be null."
{ jsonrpc: "2.0"; id: string | number; method: string; params?: { [key: string]: unknown } }

// Result — "MUST include a result field"; "MAY follow any JSON object structure"
{ jsonrpc: "2.0"; id: string | number; result: { resultType: string; [key: string]: unknown } }

// Error
{ jsonrpc: "2.0"; id?: string | number; error: { code: number; message: string; data?: unknown } }

// Notification — "MUST NOT include an ID"; "The receiver MUST NOT send a response."
{ jsonrpc: "2.0"; method: string; params?: { [key: string]: unknown } }
```

Additional constraints stated in that page:

* "The request ID **MUST NOT** match the ID of any other request the sender has issued and
  not yet received a response for."
* "Error codes **MUST** be integers."
* Result responses "**MUST** include the same ID as the request they correspond to."

**`resultType` (new in 2026-07-28, easy to miss):**

* `"complete"` — ordinary result.
* `"input_required"` — MRTR interim result (see §6.4).
* "For backward compatibility with servers implementing earlier protocol versions, which
  do not include `resultType`, clients **MUST** treat an absent `resultType` as
  `"complete"`."
* "A `resultType` of any value unrecognized by the client **MUST** be considered invalid."

### 1.2 The `initialize` handshake (legacy: `2025-11-25` and earlier)

Source: `2025-11-25/basic/lifecycle`. This is the shape essentially every deployed
server speaks today, and the one to implement first.

"The initialization phase **MUST** be the first interaction between client and server."
The client initiates with an `initialize` request containing: protocol version supported,
client capabilities, client implementation information.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {},
      "elicitation": { "form": {}, "url": {} },
      "tasks": { "requests": { "elicitation": { "create": {} }, "sampling": { "createMessage": {} } } }
    },
    "clientInfo": {
      "name": "ExampleClient",
      "title": "Example Client Display Name",
      "version": "1.0.0",
      "description": "An example MCP client application",
      "icons": [ { "src": "https://example.com/icon.png", "mimeType": "image/png", "sizes": ["48x48"] } ],
      "websiteUrl": "https://example.com"
    }
  }
}
```

Server response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "logging": {},
      "prompts": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "tools": { "listChanged": true }
    },
    "serverInfo": { "name": "ExampleServer", "title": "…", "version": "1.0.0", "description": "…", "icons": [], "websiteUrl": "…" },
    "instructions": "Optional instructions for the client"
  }
}
```

* Required params in `initialize`: `protocolVersion`, `capabilities`, `clientInfo`
  (all three appear in the spec's required example; the prose says the client "**MUST**
  initiate this phase by sending an `initialize` request containing: Protocol version
  supported, Client capabilities, Client implementation information").
* `clientInfo` / `serverInfo` are `Implementation` objects: `name` and `version` are the
  meaningful fields; `title`, `description`, `icons`, `websiteUrl` are optional additions.
* `instructions` on the server result is optional free-form text addressed to the model.
* **`protocolVersion` strings in use:** the revision date, literally. `"2024-11-05"`,
  `"2025-03-26"`, `"2025-06-18"`, `"2025-11-25"`, `"2026-07-28"`.
* **[GAP]** Which exact string Claude Code's v1 runtime (MCP TypeScript SDK 1.x) puts in
  `initialize.params.protocolVersion` is not stated anywhere I could fetch. The Claude
  Code docs only say the **v2** runtime (SDK 2.0) "adds MCP protocol revision 2026-07-28"
  and "asks HTTP, stdio, and claude.ai connector servers whether they support the newer
  revision, and uses it with those that do" (`code.claude.com/docs/en/mcp.md`).
  A server should not depend on any one string: echo back what the client sent if you
  support it, otherwise offer your newest supported revision.

### 1.3 `initialized` notification

"After successful initialization, the client **MUST** send an `initialized` notification
to indicate it is ready to begin normal operations." The method name is
**`notifications/initialized`**:

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

Ordering rules from the same page:

* "The client **SHOULD NOT** send requests other than pings before the server has
  responded to the `initialize` request."
* "The server **SHOULD NOT** send requests other than pings and logging before receiving
  the `initialized` notification."

### 1.4 Version negotiation when the two sides disagree (legacy)

Verbatim from `2025-11-25/basic/lifecycle#version-negotiation`:

> In the `initialize` request, the client **MUST** send a protocol version it supports.
> This **SHOULD** be the *latest* version supported by the client.
>
> If the server supports the requested protocol version, it **MUST** respond with the same
> version. Otherwise, the server **MUST** respond with another protocol version it
> supports. This **SHOULD** be the *latest* version supported by the server.
>
> If the client does not support the version in the server's response, it **SHOULD**
> disconnect.

So in the legacy era a version mismatch is **not** an error — it is a normal result whose
`protocolVersion` differs. The only error shape shown for initialization failure is:

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32602, "message": "Unsupported protocol version",
             "data": { "supported": ["2024-11-05"], "requested": "1.0.0" } } }
```

### 1.5 The modern (2026-07-28) model — no handshake at all

`2026-07-28/basic/versioning` and the changelog: "Make MCP stateless: remove the
`initialize`/`notifications/initialized` handshake. Every request now carries its protocol
version and client capabilities in `_meta`."

Per-request `_meta` fields, from `basic/index#meta`:

| Key | Type | Required | Notes |
|---|---|---|---|
| `io.modelcontextprotocol/protocolVersion` | string | **Yes** | e.g. `"2026-07-28"` |
| `io.modelcontextprotocol/clientCapabilities` | `ClientCapabilities` | **Yes** | `{}` is valid |
| `io.modelcontextprotocol/clientInfo` | `Implementation` | No | clients SHOULD include it |
| `io.modelcontextprotocol/logLevel` | `LoggingLevel` | No | per-request log level |

```json
{
  "jsonrpc": "2.0", "id": "discover-1", "method": "server/discover",
  "params": { "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {} } }
}
```

"A request missing any required field is malformed; the server **MUST** reject it with
JSON-RPC error code `-32602` (Invalid params). On HTTP, the response status **MUST** be
`400 Bad Request`."

Servers **MUST** implement `server/discover`; clients **MAY** call it first. Response
fields: `supportedVersions: string[]`, `capabilities`, `_meta["io.modelcontextprotocol/serverInfo"]`,
`instructions?`, plus `ttlMs` / `cacheScope`.

Version mismatch (modern) is an error:

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32022, "message": "Unsupported protocol version",
             "data": { "supported": ["2026-07-28", "2025-11-25"], "requested": "1900-01-01" } } }
```

"The client **SHOULD** select a mutually supported version from the `supported` list and
retry the request, or surface an error to the user if no compatible version exists."

**Era detection** (needed if you want to talk to both kinds of server):

* stdio: send `server/discover` with your preferred modern version. A `DiscoverResult` or a
  *recognized modern error* (-32022, -32020, -32021) ⇒ modern server; **do not** fall back.
  Any other error, or no response in a reasonable timeout ⇒ legacy ⇒ do `initialize`.
  The spec is explicit: "The fallback **MUST NOT** be keyed to one specific error code:
  legacy servers respond to unknown pre-`initialize` requests with implementation-defined
  errors (commonly `-32601` or `-32602`) or not at all."
* Streamable HTTP: attempt a modern request; on `400 Bad Request`, inspect the body.
  Recognized modern error ⇒ modern. Empty/other body ⇒ fall back to `initialize` (and
  possibly further to HTTP+SSE).

### 1.6 Capabilities

Legacy capability keys (`2025-11-25/basic/lifecycle`):

| Side | Capability | Meaning |
|---|---|---|
| Client | `roots` | can provide filesystem roots |
| Client | `sampling` | supports LLM sampling requests |
| Client | `elicitation` | supports server elicitation |
| Client | `tasks` | task-augmented client requests |
| Client | `experimental` | non-standard features |
| Server | `prompts` | offers prompt templates |
| Server | `resources` | provides readable resources |
| Server | `tools` | exposes callable tools |
| Server | `logging` | emits structured log messages |
| Server | `completions` | argument autocompletion |
| Server | `tasks` | task-augmented server requests |
| Server | `experimental` | non-standard features |

Sub-capabilities worth implementing: `listChanged` on `prompts`/`resources`/`tools`, and
`subscribe` on `resources` (legacy). In `2026-07-28` an `extensions` map is added to both
capability objects, keyed by extension identifier.

### 1.7 `_meta` key naming rules (applies to your own annotations)

From `basic/index#meta`:

* Two segments: optional **prefix** then **name**; prefix is dot-separated labels ending in
  `/` (e.g. `com.example/`); reverse-DNS recommended.
* Any prefix whose **second label** is `modelcontextprotocol` or `mcp` is **reserved**:
  `io.modelcontextprotocol/`, `dev.mcp/`, `com.mcp.tools/` are reserved; `com.example.mcp/`
  is not.
* Reserved keys: `progressToken`, `io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientInfo`, `io.modelcontextprotocol/clientCapabilities`,
  `io.modelcontextprotocol/logLevel`, `io.modelcontextprotocol/subscriptionId`,
  and (exception to the prefix rule) `traceparent`, `tracestate`, `baggage`.

---

## 2. Transports

`2026-07-28/basic/transports` states the transport layer is a **binding**: "Protocol
semantics are identical on every transport. A transport is a binding: it defines how
messages are framed and delivered, how request metadata is carried, and how cancellation
and termination are signaled."

Standard transports in every revision since `2025-03-26`: **stdio** and **Streamable
HTTP**. HTTP+SSE is the deprecated `2024-11-05` transport. **WebSocket is not an MCP
specification transport** — it exists only as a Claude Code configuration type (§8.3).

### 2.1 stdio — newline-delimited JSON, not Content-Length

Verbatim requirements (`2026-07-28/basic/transports/stdio`; `2025-11-25` and `2024-11-05`
say the same thing):

* "The server reads JSON-RPC messages from `stdin` and writes JSON-RPC messages to `stdout`."
* "Each message is a single JSON-RPC request, notification, or response."
* "**Messages are delimited by newlines, and MUST NOT contain embedded newlines.**"
* "The server **MAY** write UTF-8 strings to `stderr` for any logging purposes…"
* "The client **MAY** capture, forward, or ignore the server's `stderr` output and
  **SHOULD NOT** assume `stderr` output indicates error conditions."
* "The server **MUST NOT** write anything to its `stdout` that is not a valid MCP message."
* "The client **MUST NOT** write anything to the server's `stdin` that is not a valid MCP message."
* "The client **MUST NOT** write JSON-RPC *responses*" (stdio binding).
* Modern revision: "The server **MUST NOT** write JSON-RPC *requests* to `stdout`."
  Legacy revisions **do** allow server→client requests (roots/sampling/elicitation).

**Content-Length framing: not part of MCP.** I read the stdio section of `2024-11-05`,
`2025-11-25`, and `2026-07-28` and all three specify newline delimiting. LSP-style
`Content-Length: N\r\n\r\n{...}` framing appears nowhere in those pages. (It did appear in
some early MCP SDK implementations.) Do not implement it; at most, tolerate it defensively
— **[INFERENCE]**, since the spec says nothing about it either way.

Custom transports: "Custom transports that run over a reliable bidirectional byte stream
(e.g., Unix domain sockets or TCP) **SHOULD** reuse the stdio framing rather than defining
a new one."

**Shutdown** (`2026-07-28/basic/transports/stdio`):

1. "Closing the input stream to the child process (the server)."
2. "Waiting for the server to exit."
3. "If the server does not exit within a reasonable time, forcibly terminating the process…"
   POSIX: `SIGTERM` → `SIGKILL`. Windows: `TerminateProcess` or Job Objects.
   "Servers **SHOULD** exit promptly when their standard input is closed or reads return
   end-of-file. This is the primary graceful-shutdown signal and the only portable one."

Claude Code's concrete timing (`code.claude.com/docs/en/mcp.md`, "How Claude Code stops a
stdio server"): macOS/Linux — `SIGINT`, then `SIGTERM` 100 ms later, then `SIGKILL` 400 ms
after that; Windows — closes stdin, then ends the process tree if still running 300 ms
later.

**Restart:** "If the server process exits unexpectedly, the client **SHOULD** restart it.
Because the protocol is stateless, any in-flight requests are simply lost and the client
can retry them against the fresh process." (Claude Code itself does **not** auto-reconnect
stdio servers; it does retry remote ones — see §8.6.)

**Implementing stdio framing from scratch (synthesis, not spec text).** Node builtins are
sufficient and the rules above map cleanly:

* Client side: `spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env })`. Wrap
  `child.stdout` in `readline.createInterface({ input: child.stdout, crlfDelay: Infinity })`;
  `for await (const line of rl)` yields one message per line. Ignore empty lines.
  `JSON.parse(line)`; route by the presence of `id`+`result`/`error` (response), `id`+`method`
  (server request — legacy), or `method` alone (notification).
* Write with `child.stdin.write(JSON.stringify(message) + "\n")`. `JSON.stringify` escapes
  newlines inside strings, so a serialized message can never contain a raw `\n` — this is
  what makes single-line framing safe.
* Server side: a single `readline` interface over `process.stdin`, and
  `process.stdout.write(JSON.stringify(msg) + "\n")`. **Never** use `console.log`
  (it writes to stdout); use `console.error` or `process.stderr.write`.
* Line splitting: the spec says "newlines". It says nothing about `\r`. Node's `readline`
  treats `\n`, `\r\n`, and `\r` as terminators, which is lenient enough for real servers
  and is a safe default. **[INFERENCE]**
* A silent server after launch is normal: "The command prints nothing when it starts. A
  stdio MCP server communicates over stdin and stdout, so a silent, blocked terminal means
  the server is running and waiting for a client to connect." (Claude Code `mcp serve` docs.)

### 2.2 Streamable HTTP

**2026-07-28 shape** (`basic/transports/streamable-http`):

* One endpoint (the "MCP endpoint") that supports **POST**. No GET stream, no sessions.
* Client MUST POST each message as its own request; MUST send
  `Accept: application/json, text/event-stream`; MUST send the request-metadata headers.
* Body MUST be a single *request* or *notification*; clients MUST NOT send responses.
* Notification accepted ⇒ `202 Accepted` with no body. Cannot accept ⇒ HTTP error status,
  body MAY be a JSON-RPC error response with no `id`.
* Request ⇒ either `Content-Type: application/json` (one JSON object) or
  `Content-Type: text/event-stream` (SSE stream scoped to that request). Clients MUST
  support both.
* On the SSE response stream the server MAY send notifications related to that request
  (progress, log messages) before the final response; the final response SHOULD terminate
  the stream.
* Server-to-client interactions (sampling, elicitation, roots) are **not** separate
  requests in this revision — they are embedded in `InputRequiredResult` (MRTR).
* Servers SHOULD send `X-Accel-Buffering: no`; keep-alive SSE comment lines (`:\r\n`) are
  suggested for long-lived streams.
* "Resumable SSE streams via `Last-Event-ID` are not supported." A broken stream loses the
  in-flight request; clients MUST re-issue it with a **new** request ID.

**Required request headers (2026-07-28):**

| Header | Source | Required for |
|---|---|---|
| `MCP-Protocol-Version` | `_meta["io.modelcontextprotocol/protocolVersion"]` | every POST |
| `Mcp-Method` | `method` | all requests |
| `Mcp-Name` | `params.name` or `params.uri` | `tools/call`, `resources/read`, `prompts/get` |
| `Mcp-Param-{Name}` | tool parameter marked `x-mcp-header` in `inputSchema` | when such a parameter has a value |

Header values that are not plain ASCII (or that have leading/trailing whitespace, or match
the sentinel pattern) use Base64 sentinel encoding:
`Mcp-Param-{Name}: =?base64?{Base64}?=` — markers lowercase and case-sensitive. Header
names are case-insensitive; header **values** are case-sensitive. Mismatch ⇒ `400` with
error code `-32020` (`HeaderMismatch`).

**2025-03-26 … 2025-11-25 shape** (still what most remote servers implement):

* MCP endpoint supports both POST and GET.
* Server MAY assign a session at initialization via the `MCP-Session-Id` response header;
  clients MUST echo it on all subsequent requests; 404 ⇒ start a new session by sending a
  fresh `InitializeRequest`; clients SHOULD `DELETE` the endpoint with the header to
  terminate (server MAY answer `405`).
* Client MAY `GET` the endpoint to open a standalone SSE stream for server-initiated
  messages; server MUST either return `text/event-stream` or `405`.
* Resumability: SSE event `id`s + `Last-Event-ID` on reconnect; `retry` field honored.
* Servers MAY send JSON-RPC **requests** on SSE streams (that is how sampling/elicitation/
  roots worked).
* Client MUST include `MCP-Protocol-Version: <negotiated version>` on all subsequent
  requests; a server that sees no such header and has no other way to identify the version
  SHOULD assume `2025-03-26`; an invalid/unsupported version ⇒ `400 Bad Request`.

### 2.3 HTTP+SSE (2024-11-05) — deprecated

Two endpoints: an SSE endpoint for server→client messages and a POST endpoint for
client→server messages. "When a client connects, the server **MUST** send an `endpoint`
event containing a URI for the client to use for sending messages. All subsequent client
messages **MUST** be sent as HTTP POST requests to this endpoint. Server messages are sent
as SSE `message` events, with the message content encoded as JSON in the event data."
Claude Code calls this transport `sse` and marks it deprecated; it tries HTTP first and
switches when the server doesn't accept it (v2.1.265+).

Fallback detection (both eras): POST first; on `400`/`404`/`405` with a body that is **not**
a recognized modern JSON-RPC error, GET the URL and expect the `endpoint` event.

### 2.4 Cancellation and progress per transport

* stdio (modern): client sends `notifications/cancelled` referencing the request ID.
* Streamable HTTP (modern): "Closing the SSE response stream **MUST** be treated by the
  server as cancellation of that request."
* Legacy Streamable HTTP: disconnection is **not** cancellation; the client SHOULD send an
  explicit cancellation notification.

---

## 3. Tools

### 3.1 Capability

```json
{ "capabilities": { "tools": { "listChanged": true } } }
```

"Servers that support tools **MUST** declare the `tools` capability." A server that
declares it "**MUST** respond to `tools/list` requests with the set of tools currently
available to the requesting client. This set **MAY** be empty and **MAY** change over time…
but **MUST NOT** vary per-connection or as a side effect of other requests on the
connection." (It may vary by *authorization* presented on the request.) Servers **SHOULD**
return tools in a deterministic order.

### 3.2 `tools/list`

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": { "cursor": "optional-cursor-value" } }
```

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": {
    "resultType": "complete",
    "tools": [ { "name": "get_weather", "title": "Weather Information Provider",
                 "description": "Get current weather information for a location",
                 "inputSchema": { "type": "object",
                                  "properties": { "location": { "type": "string", "description": "City name or zip code" } },
                                  "required": ["location"] },
                 "icons": [ { "src": "https://example.com/weather-icon.png", "mimeType": "image/png", "sizes": ["48x48"] } ] } ],
    "nextCursor": "next-page-cursor",
    "ttlMs": 300000,
    "cacheScope": "public"
  } }
```

* **Pagination**: yes, via `params.cursor` and result `nextCursor`. "Clients **SHOULD**:
  Treat a missing `nextCursor` as the end of results." "Clients **MUST** treat cursors as
  opaque tokens… Don't make any determination based on cursor value other than whether a
  non-null value was provided (e.g. an empty string is a valid cursor and thus **MUST NOT**
  be treated as the end of results)." Invalid cursor SHOULD yield `-32602`.
* `ttlMs` / `cacheScope` (`"public"` | `"private"`) are **new in 2026-07-28** and required
  on cacheable results there (changelog item). Absent in earlier revisions.
* `resultType` absent on legacy servers ⇒ treat as `"complete"`.

### 3.3 Tool descriptor fields

From `2026-07-28/server/tools#tool` (same list in `2025-06-18`/`2025-11-25` minus
`icons`/`execution` differences):

* `name` — required, unique identifier.
* `title` — optional human-readable display name.
* `description` — human-readable description of functionality.
* `icons` — optional array of `{ src, mimeType?, sizes?, theme? }`.
* `inputSchema` — required. JSON Schema, defaults to **2020-12** when no `$schema` is
  present; "**MUST** be a valid JSON Schema object (not `null`)". For no-parameter tools:
  use `{ "type": "object", "additionalProperties": false }` (recommended) or `{ "type": "object" }`.
* `outputSchema` — optional JSON Schema for structured results.
* `annotations` — "Optional properties describing tool behavior."
* (`execution.taskSupport` exists in 2025-11-25; tasks moved to an extension in 2026-07-28.)

**Tool annotations — field names confirmed, semantics NOT verified.** The spec pages I
fetched only say "annotations: Optional properties describing tool behavior" and warn:
"clients **MUST** consider tool annotations to be untrusted unless they come from trusted
servers." The four hint names are confirmed by the MCP Tool Annotations Interest Group
charter: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Their exact
defaults and descriptions live in the `ToolAnnotations` schema entry, which the truncated
schema page never reached — **[GAP]**. The commonly cited defaults
(`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`,
`openWorldHint: true`) are **[UNVERIFIED]** here; check
`https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations` before
relying on them.

**Tool name rules** (spec prose, all `SHOULD`-level, not MUST):

* 1–128 characters inclusive.
* Case-sensitive.
* Only `A-Z`, `a-z`, `0-9`, `_`, `-`, `.`.
* No spaces, commas or other special characters.
* Unique within a server.

Collision guidance (important for a client):

> Tool name uniqueness is scoped to a single server. Clients or proxies that aggregate
> tools from multiple servers **MAY** encounter naming collisions (for example, two servers
> each exposing a `search` tool) and **SHOULD** implement a disambiguation strategy such
> as prefixing tool names with a server identifier. The server `name` (from `serverInfo`)
> is not guaranteed to be unique across servers and **SHOULD NOT** be relied upon for
> disambiguation.

`x-mcp-header`: a property inside `inputSchema.properties.<p>` whose value names an HTTP
header suffix. Constraints (MUST NOT be empty; token syntax; no CR/LF; case-insensitively
unique; primitive types only, **not** `number`; statically reachable through `properties`
keys only). Clients on Streamable HTTP **MUST** reject a tool whose `x-mcp-header` is
invalid by excluding it from `tools/list` and SHOULD log a warning; clients on other
transports MAY ignore the annotation entirely.

### 3.4 `tools/call`

Request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "get_weather", "arguments": { "location": "New York" } } }
```

Successful result (modern):

```json
{ "jsonrpc": "2.0", "id": 2,
  "result": { "resultType": "complete",
              "content": [ { "type": "text", "text": "Current weather in New York:\nTemperature: 72°F\nConditions: Partly cloudy" } ],
              "isError": false } }
```

`content` item types:

| `type` | Fields |
|---|---|
| `text` | `text` |
| `image` | `data` (base64), `mimeType`, optional `annotations` |
| `audio` | `data` (base64), `mimeType` |
| `resource_link` | `uri`, `name`, `description?`, `mimeType?`, `annotations?` — "are not guaranteed to appear in the results of a `resources/list` request" |
| `resource` | `resource: { uri, mimeType?, text? \| blob?, annotations? }` (embedded resource) |

All content types support the shared `annotations` object
(`audience`, `priority`, `lastModified`).

**`structuredContent`**: "**Structured** content is returned as a JSON value in the
`structuredContent` field of a result. This can be any JSON value (object, array, string,
number, boolean, or null) that conforms to the tool's `outputSchema` if one is defined."
In `2025-11-25` and earlier it was restricted to a JSON **object**. "For backwards
compatibility, a tool that returns structured content SHOULD also return the serialized
JSON in a TextContent block." Servers that declare `outputSchema` MUST return conforming
structured results; clients SHOULD validate.

**`isError`**: part of the *result*, so a failing tool call is still a **successful
JSON-RPC response**. Modern tools may also answer with `InputRequiredResult`
(`resultType: "input_required"`, plus `inputRequests` and optional `requestState`); the
client retries with `inputResponses` and **"the JSON-RPC `id` MUST be different between the
initial request and the retry."**

### 3.5 How a tool name is namespaced in Claude Code

From `code.claude.com/docs/en/agent-sdk/mcp.md#tool-naming-convention`:

> MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>`. For example, a
> GitHub server named `"github"` with a `list_issues` tool becomes `mcp__github__list_issues`.

Plugin-bundled servers use a longer form (`code.claude.com/docs/en/mcp.md`):

> The full form is `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`, where any
> character outside `A-Z`, `a-z`, `0-9`, `_`, and `-` is replaced with `_`.
> Example: `mcp__plugin_my-plugin_database-tools__query`.

The same page notes the server itself registers under the scoped name
`plugin:<plugin-name>:<server-name>` for places that expect a configured server name.

Permission-rule implications (`docs/en/permissions.md`): deny/ask rules accept tool-name
globs — `"mcp__*"` denies every MCP tool; allow rules "accept tool-name globs only after a
literal `mcp__<server>__` prefix" (e.g. `mcp__puppeteer__*`, `mcp__github__get_*`), and an
unanchored allow glob such as `"*"` or `"mcp__*"` "is skipped with a warning".

Also from the same page: "When Claude Code loads a settings file, it skips any `mcp__` rule
that has parentheses" — parameter matching (`Tool(param:value)`) is not available for MCP
tools in settings files; it works only through `--disallowedTools`.

---

## 4. Resources

### 4.1 Capability

```json
{ "capabilities": { "resources": { "listChanged": true, "subscribe": true } } }
```

Either feature may be advertised independently; a server supporting neither may send
`{ "resources": {} }`.

### 4.2 Messages

```json
{ "jsonrpc": "2.0", "id": 1, "method": "resources/list", "params": { "cursor": "optional-cursor-value" } }
```

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "resultType": "complete",
    "resources": [ { "uri": "file:///project/src/main.rs", "name": "main.rs",
                     "title": "Rust Software Application Main File",
                     "description": "Primary application entry point",
                     "mimeType": "text/x-rust",
                     "icons": [ … ] } ],
    "nextCursor": "next-page-cursor", "ttlMs": 300000, "cacheScope": "public" } }
```

Resource descriptor fields: `uri` (required, unique identifier), `name` (required),
`title?`, `description?`, `icons?`, `mimeType?`, `size?` (bytes), `annotations?`.

```json
{ "jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": { "uri": "file:///project/src/main.rs" } }
```

```json
{ "jsonrpc": "2.0", "id": 2,
  "result": { "resultType": "complete",
    "contents": [ { "uri": "file:///project/src/main.rs", "mimeType": "text/x-rust",
                    "text": "fn main() {\n    println!(\"Hello world!\");\n}" } ],
    "ttlMs": 60000, "cacheScope": "private" } }
```

Contents are either `{ uri, mimeType?, text }` or `{ uri, mimeType?, blob }` (base64).
"Servers **MAY** return multiple resource contents in response to a single
`resources/read` request."

```json
{ "jsonrpc": "2.0", "id": 3, "method": "resources/templates/list", "params": { "cursor": "optional-cursor-value" } }
```

```json
{ "jsonrpc": "2.0", "id": 3,
  "result": { "resultType": "complete",
    "resourceTemplates": [ { "uriTemplate": "file:///{path}", "name": "Project Files",
                             "title": "📁 Project Files",
                             "description": "Access files in the project directory",
                             "mimeType": "application/octet-stream", "icons": [ … ] } ],
    "nextCursor": "next-page-cursor", "ttlMs": 300000, "cacheScope": "public" } }
```

URI templates use RFC 6570. Arguments may be autocompleted via `completion/complete`.

Annotations (shared with resources, templates, and content blocks): `audience` (array of
`"user"` / `"assistant"`), `priority` (0.0–1.0, 1 = most important), `lastModified`
(ISO 8601). Standard URI schemes: `https://` (client can fetch directly; servers SHOULD
use it only if the client can load it without the server), `file://` (filesystem-like; MAY
use XDG MIME types like `inode/directory`), `git://`, plus custom RFC 3986 schemes.

**Resource errors:** "If the requested resource does not exist, servers **MUST** return a
JSON-RPC error with code `-32602` (Invalid Params). Servers **SHOULD** return `-32603` for
internal errors. For backwards compatibility, clients **SHOULD** also accept `-32002` as a
resource not found error, as earlier protocol versions used this code." Also:
"Servers **MUST NOT** return an empty `contents` array for a non-existent resource."

### 4.3 Subscriptions to resource changes

* Legacy: `resources/subscribe` / `resources/unsubscribe` (guarded by the `subscribe`
  capability), updates delivered as `notifications/resources/updated`.
* `2026-07-28`: those RPCs and the HTTP GET stream are gone. Clients send
  `subscriptions/listen` with a filter that includes `resourceSubscriptions: [uri, …]`
  (see §6.3).

### 4.4 How resources reach a model that has no resource concept (Claude Code)

From the 2026-02-08 capture of the official `mcp.md`, section **"Use MCP resources"**:

* "MCP servers can expose resources that you can reference using @ mentions, similar to
  how you reference files."
* "Type `@` in your prompt to see available resources from all connected MCP servers.
  Resources appear alongside files in the autocomplete menu."
* Reference syntax: **`@server:protocol://resource/path`**. Examples given:
  `@github:issue://123`, `@docs:file://api/authentication`,
  `@postgres:schema://users`.
* "Resources are automatically fetched and included as attachments when referenced."
* "Claude Code automatically provides tools to list and read MCP resources when servers
  support them." — i.e. the model does not need a native resource primitive; the client
  exposes list/read as ordinary tools and the `@` mention path attaches content directly.
* "Resource paths are fuzzy-searchable in the @ mention autocomplete."

---

## 5. Prompts

### 5.1 Capability

```json
{ "capabilities": { "prompts": { "listChanged": true } } }
```

### 5.2 `prompts/list`

```json
{ "jsonrpc": "2.0", "id": 1, "method": "prompts/list", "params": { "cursor": "optional-cursor-value" } }
```

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "resultType": "complete",
    "prompts": [ { "name": "code_review", "title": "Request Code Review",
                   "description": "Asks the LLM to analyze code quality and suggest improvements",
                   "arguments": [ { "name": "code", "description": "The code to review", "required": true } ],
                   "icons": [ … ] } ],
    "nextCursor": "next-page-cursor", "ttlMs": 600000, "cacheScope": "public" } }
```

Prompt descriptor fields: `name` (required, unique), `title?`, `description?`, `icons?`,
`arguments?` (each `{ name, description?, required? }`).

### 5.3 `prompts/get`

```json
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/get",
  "params": { "name": "code_review", "arguments": { "code": "def hello():\n    print('world')" } } }
```

```json
{ "jsonrpc": "2.0", "id": 2,
  "result": { "resultType": "complete", "description": "Code review prompt",
    "messages": [ { "role": "user",
                    "content": { "type": "text", "text": "Please review this Python code:\ndef hello():\n    print('world')" } } ] } }
```

* `role`: `"user"` or `"assistant"`.
* `content` is a **prompt content block**, not a tool result block: `text`, `image`
  (`data` + `mimeType`), `audio`, `resource_link`, or embedded `resource`. All support
  `annotations`.
* Errors: invalid prompt name `-32602`, missing required arguments `-32602`, internal
  `-32603`.
* May answer with `InputRequiredResult` in `2026-07-28`.

### 5.4 How a prompt becomes something a user can invoke (Claude Code)

From the 2026-02-08 capture of the official `mcp.md`, section **"Use MCP prompts as
commands"**:

* "Type `/` to see all available commands, including those from MCP servers. MCP prompts
  appear with the format **`/mcp__servername__promptname`**."
* Examples: `/mcp__github__list_prs`, `/mcp__github__pr_review 456`,
  `/mcp__jira__create_issue "Bug in login flow" high`.
* "Many prompts accept arguments. Pass them space-separated after the command."
* "MCP prompts are dynamically discovered from connected servers"; "Arguments are parsed
  based on the prompt's defined parameters"; "Prompt results are injected directly into the
  conversation"; "Server and prompt names are normalized (spaces become underscores)."

The current `commands.md` confirms this and links back:
"MCP servers can expose prompts that appear as commands. See [MCP prompts]."

---

## 6. Notifications

Direction rules (modern, `basic/transports`): "A binding **MUST** deliver client-sent
*requests* and *notifications* to the server, and server-sent *responses* and
*notifications* to the client. No other message direction exists… servers do not initiate
JSON-RPC requests and clients do not send JSON-RPC responses."

### 6.1 Legacy server→client requests (not notifications, but easy to conflate)

In `2025-11-25` and earlier the server **may send requests** to the client: `roots/list`,
`sampling/createMessage`, `elicitation/create`, and pings. Claude Code answers `roots/list`
and emits `notifications/roots/list_changed`:

> A server that limits its own filesystem access to a set of allowed directories should
> implement the MCP `roots/list` request instead. Claude Code answers `roots/list` with the
> session's launch directory plus every additional working directory you've granted with
> `--add-dir`, `/add-dir`, or the `additionalDirectories` setting. Claude Code sends
> `notifications/roots/list_changed` when that set changes.
> (`code.claude.com/docs/en/mcp.md`, Option 3)

In `2026-07-28` these become `InputRequiredResult` MRTR replies instead (changelog item 7).

### 6.2 Simple notifications

| Method | Direction | Params |
|---|---|---|
| `notifications/initialized` | client → server | none |
| `notifications/cancelled` | client → server | `{ requestId, reason? }` (legacy); stdio-only in 2026-07-28 |
| `notifications/progress` | server → client | `{ progressToken, progress, total?, message? }` |
| `notifications/message` | server → client | `{ level, logger?, data }` |
| `notifications/tools/list_changed` | server → client | none (modern: only on a listen stream) |
| `notifications/prompts/list_changed` | server → client | none |
| `notifications/resources/list_changed` | server → client | none |
| `notifications/resources/updated` | server → client | `{ uri, _meta.subscriptionId }` |
| `notifications/roots/list_changed` | client → server | none (removed in 2026-07-28) |

**Progress** (`2026-07-28/basic/patterns/progress`): the client opts in by putting
`progressToken` in the request's `_meta`. "Progress tokens **MUST** be a string or integer
value" and "**MUST** be unique across all active requests." "The `progress` value **MUST**
increase with each notification, even if the total is unknown." `progress` and `total` MAY
be floating point. "Progress notifications **MUST** stop after completion."

**Logging** (`2026-07-28/server/utilities/logging`) — **deprecated as of 2026-07-28**
(SEP-2577), still in the spec for at least 12 months. Levels follow RFC 5424: `debug`,
`info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`. Modern: verbosity is
per-request via `_meta["io.modelcontextprotocol/logLevel"]`, and "the server **MUST NOT**
emit `notifications/message` for a request that does not include this field"; log messages
are request-scoped and must not be sent on a listen stream. Legacy: `logging/setLevel`
(replaced by the `_meta` field, which no longer exists in 2026-07-28).

### 6.3 List-changed in 2026-07-28: opt-in via `subscriptions/listen`

This is the biggest behavioral change a naive client will miss. `notifications/*/list_changed`
are **no longer unsolicited**: servers send them only on a stream opened by a
`subscriptions/listen` request.

```json
{ "jsonrpc": "2.0", "id": 1, "method": "subscriptions/listen",
  "params": {
    "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
               "io.modelcontextprotocol/clientCapabilities": {} },
    "notifications": { "toolsListChanged": true,
                       "resourceSubscriptions": ["file:///project/config.json"] } } }
```

Filter fields: `toolsListChanged`, `promptsListChanged`, `resourcesListChanged` (booleans),
`resourceSubscriptions` (array of URIs). "The server **MUST NOT** send notification types
the client has not explicitly requested."

The server MUST first send `notifications/subscriptions/acknowledged` with the *subset* it
agreed to honor, carrying `_meta["io.modelcontextprotocol/subscriptionId"]` = the JSON-RPC
id of the listen request. "On stdio, where all messages share a single channel, clients
**MUST** use this field to correlate notifications with their originating subscription."
Cancellation: client closes the SSE stream (HTTP) or sends `notifications/cancelled` (stdio);
graceful server-side end is signaled by responding to the original `subscriptions/listen`
request with a `resultType: "complete"` result.

### 6.4 `InputRequiredResult` (MRTR) — replaces server-initiated requests

```json
{ "jsonrpc": "2.0", "id": 2,
  "result": { "resultType": "input_required",
    "inputRequests": { "github_login": { "method": "elicitation/create",
        "params": { "mode": "form", "message": "Please provide your GitHub username",
                    "requestedSchema": { "type": "object", "properties": { "name": { "type": "string" } },
                                         "required": ["name"] } } } },
    "requestState": "eyJsb2NhdGlvbiI6Ik5ldyBZb3JrIn0..." } }
```

Client retries the same method with `inputResponses` and, if given, `requestState`; the
retry **MUST** use a different JSON-RPC `id`.

### 6.5 How a client should respond to notifications

* JSON-RPC 2.0 (and MCP) — the receiver **MUST NOT** send a response to a notification.
  Do not echo, do not ack (the only "ack" in the protocol is
  `notifications/subscriptions/acknowledged`, which the **server** sends).
* Unknown **notification** method: ignore it. Unknown **request** method: reply
  `-32601 Method not found` (the code appears in the schema as `MethodNotFoundError`, and
  the Streamable HTTP chapter pairs a `404` with `-32601`).
* `notifications/message` (logging) is display/debug only; it must not be fed to the model
  as tool output.
* `notifications/progress` is the one notification that should affect control flow: it
  resets idle timers in many clients. Claude Code is an exception — "The per-server
  `timeout` is a hard wall-clock limit per tool call, and progress notifications from the
  server don't extend it."

---

## 7. Errors

### 7.1 Error object

```json
{ "jsonrpc": "2.0", "id": 3,
  "error": { "code": -32602, "message": "Unknown tool: invalid_tool_name" } }
```

"MCP uses the standard JSON-RPC 2.0 error codes (`-32700`, `-32600` to `-32603`) for general
protocol failures." (Standard meanings: `-32700` Parse error, `-32600` Invalid Request,
`-32601` Method not found, `-32602` Invalid params, `-32603` Internal error.)

`error.message` is "A short description of the error… SHOULD be limited to a concise single
sentence." `error.data` is sender-defined.

### 7.2 Code allocation (2026-07-28)

* `-32000` … `-32019` — **legacy**, implementation-defined. "New codes **MUST NOT** be
  allocated in this sub-range" and new implementations "**SHOULD NOT** use codes from this
  sub-range at all. Apart from `-32002`… receivers **MUST NOT** assume any specific meaning."
* `-32020` … `-32099` — **reserved for the MCP specification**. Implementations MUST NOT
  emit undefined codes from this range.
* Application-defined errors SHOULD be allocated **outside** `-32768` … `-32000`.

Spec-defined codes:

| Code | Name | Notes |
|---|---|---|
| `-32020` | `HeaderMismatch` | HTTP headers disagree with the body, or required headers missing/malformed; HTTP status MUST be `400` |
| `-32021` | `MissingRequiredClientCapability` | `data.requiredCapabilities` names them; HTTP `400` |
| `-32022` | `UnsupportedProtocolVersion` | `data: { supported: string[], requested: string }`; HTTP `400` |

Retired but still worth accepting: `-32002` (resource not found, ≤2025-11-25 — replaced by
`-32602`; clients SHOULD still accept it) and `-32042` (URL elicitation required,
2025-11-25 only).

### 7.3 Protocol error vs tool execution error

The spec is explicit that these are two different mechanisms:

1. **Protocol errors** — JSON-RPC error responses. Cases: unknown tool, malformed request
   that fails the `CallToolRequest` schema, server errors. Example:
   `{"code": -32602, "message": "Unknown tool: invalid_tool_name"}`.
2. **Tool execution errors** — a **normal result** with `isError: true`, carrying
   model-actionable text: API failures, input validation ("date in wrong format, value out
   of range"), business-logic failures.

Client obligations: "Clients **MAY** provide protocol errors to language models, though
these are less likely to result in successful recovery. Clients **SHOULD** provide tool
execution errors to language models to enable self-correction."

Claude Code's treatment of `isError` results (from the mirror of the official page, the
live page truncated just before): Claude receives the result's text as the tool's error
message; error text longer than about 11,000 characters keeps only its first 5,000 and last
5,000 characters with a marker between them.

---

## 8. Configuration in Claude Code

Sources: `docs/en/mcp.md`, `docs/en/mcp-quickstart.md`, `docs/en/agent-sdk/mcp.md`, and the
2026-02-08 capture for "Managed MCP configuration".

### 8.1 The config file shape

Every scope uses the same JSON with a wrapper key `mcpServers`:

```json
{
  "mcpServers": {
    "claude-code-docs": { "type": "http", "url": "https://code.claude.com/docs/mcp" },
    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```

Field inventory by transport:

| `type` | Fields |
|---|---|
| `"stdio"` (or **absent**) | `command` (required), `args` (array), `env` (object), plus `timeout`, `alwaysLoad` |
| `"http"` | `url`, `headers`, `headersHelper`, `timeout`, `alwaysLoad`, `oauth` |
| `"sse"` | same as `http` (deprecated transport) |
| `"ws"` | same as `http`: `url`, `headers`, `headersHelper`, `timeout`, `alwaysLoad`. "Authentication is header-only"; `--transport` does not accept `ws` |
| `"sdk"` | in-process; **only** an SDK host app (Agent SDK, desktop app) can register it; Claude Code skips it in `.mcp.json`/`~/.claude.json`/settings |

* `"streamable-http"` is accepted as an **alias for `"http"`** in `.mcp.json`,
  `~/.claude.json`, and `claude mcp add-json` — because "The MCP specification uses the name
  `streamable-http` for this transport".
* An entry with a `url` but **no `type`** is a configuration error: "Claude Code reads an
  entry with no `type` as a stdio server." The reported message is
  `MCP server "<name>" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry`.
* `oauth` object: `{ "clientId": …, "callbackPort": 8080, "authServerMetadataUrl": "https://…", "scopes": "scope-a scope-b" }`.
  `authServerMetadataUrl` must be `https://`. `scopes` is "a single space-separated string,
  matching the `scope` parameter format in RFC 6749 §3.3".
* `headersHelper`: a shell command run at connect time that "must write a JSON object of
  string key-value pairs to stdout"; 10-second limit; dynamic headers override static
  `headers` with the same name; re-run on `401`/`403` tool calls. Claude Code sets
  `CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL`, and (plugins only)
  `CLAUDE_PLUGIN_ROOT` in the helper's environment.
* Server names in `claude mcp` commands and imports: only letters, numbers, hyphens, and
  underscores. Reserved names Claude Code refuses: `workspace`, `claude-in-chrome`,
  `computer-use`, `Claude Preview`, `Claude Browser`.

### 8.2 Transport selection

* Command line: `--transport http | sse | stdio`. `http` is the recommended default for
  remote servers; Claude Code "tries the HTTP transport first and switches to SSE when the
  server doesn't accept it" (v2.1.265+).
* In JSON config: driven by `type` (with the stdio default and the `streamable-http` alias).
* WebSocket (`wss://`) requires a JSON entry with `"type": "ws"`; there is no CLI flag.

### 8.3 Scopes, storage, precedence

| Scope | Stored in | Loads in | Shared |
|---|---|---|---|
| `local` (default) | `~/.claude.json` under `projects["<path>"].mcpServers` | current project only | no |
| `project` | `.mcp.json` at project root | current project | yes (VCS) |
| `user` | `~/.claude.json` top-level `mcpServers` | all your projects | no |

Precedence when the same server name is defined more than once — "Claude Code connects to
it once, using the definition from the highest-precedence source. The entire server entry
from that source is used; **fields are not merged across scopes**":

1. local
2. project
3. user
4. plugin-provided servers
5. claude.ai connectors

Organization `managedMcpServers` ranks above all of these. Duplicates across the three
scopes are matched **by name**; plugins and connectors are matched **by endpoint**
("Two URL spellings count as the same endpoint when they differ only in the letter case of
the scheme or host, the scheme's default port, such as `:443` on `https`, or a trailing
slash.").

Approval: project-scoped `.mcp.json` servers require interactive approval
(`claude mcp reset-project-choices` resets); `enabledMcpjsonServers` /
`disabledMcpjsonServers` / `enableAllProjectMcpServers` govern this in settings;
`disabledMcpjsonServers` blocks in every permission mode. Per-project `/mcp` toggles are
recorded in `~/.claude.json` in `disabledMcpServers` or `enabledMcpServers` — "Claude Code
consults exactly one of the two lists for each server".

### 8.4 Environment variable expansion

* Syntax: `${VAR}` and `${VAR:-default}`. Nothing else — a bare `$VAR` is **not** expanded.
* Locations: `command`, `args`, `env`, `url`, `headers`.
* Unset with no default: "the config still loads: Claude Code reports a missing-variable
  warning for that server… and uses the unexpanded `${VAR}` text as-is."
* Credential variables: in a remote server's `url` and `headers`, "Claude Code reads
  credential variables from your environment as empty rather than expanding them" — this
  covers Claude Code's own credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`),
  cloud-provider credentials (`AWS_BEARER_TOKEN_BEDROCK`), and others such as `HTTPS_PROXY`
  and `NPM_TOKEN`. A `:-default` fallback on a covered name is ignored; a name outside the
  set (e.g. `API_KEY`) expands normally.
* Plugin path placeholders: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${CLAUDE_PROJECT_DIR}` — substituted in stdio `command`/`args`/`env` and in
  http/sse/ws `url`/`headers`/`headersHelper`.
* Claude Code sets `CLAUDE_PROJECT_DIR` in a spawned stdio server's environment (project
  root, stable across working-directory changes). Because it is set in the *server's*
  environment, referencing it through `${...}` in a project-scoped `.mcp.json` needs a
  default, e.g. `${CLAUDE_PROJECT_DIR:-.}`.

### 8.5 Timeouts and limits Claude Code applies

| Knob | Default | Notes |
|---|---|---|
| `MCP_TIMEOUT` (env, ms) | 30 s | server startup / first-connection wait |
| per-server `timeout` (config, ms) | — | hard wall-clock limit per tool call; progress does not extend it; values < 1000 are ignored |
| `MCP_TOOL_TIMEOUT` (env) | ~28 h | applies when no per-server `timeout` |
| idle timeout | 5 min (HTTP/SSE/WS/connector), 30 min (stdio) | no response and no progress in the window ⇒ abort; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms; `0` disables) |
| `MAX_MCP_OUTPUT_TOKENS` | 25,000 | warning at 10,000; over-limit text results are spilled to a file in the session's `tool-results` dir and replaced by a path message |
| text result length | 50,000 chars | spilled to a file regardless of the token limit, unless the tool declares `anthropic/maxResultSizeChars` |
| response size | 16 MiB | one JSON body or one SSE event; the request fails past it. Same limit per WS message, which closes the connection |

Two Claude Code-specific per-tool hints exist for MCP servers:
`anthropic/maxResultSizeChars` (raises the per-tool character limit) and
`anthropic/requiresUserInteraction` (forces a permission prompt even when a hook returns
`"allow"`, and is denied outright in `dontAsk` mode). Both are referenced by anchor and by
a search snippet showing `"anthropic/requiresUserInteraction": true`, but the live page's
tail containing their full text was **not fetched** — treat the exact spelling as confirmed
and the semantics as **[partially verified]**.

### 8.6 Runtime behavior worth copying or deliberately skipping

* Claude Code has two MCP client runtimes: v1 on MCP TypeScript SDK 1.x, v2 on SDK 2.0
  which "adds MCP protocol revision 2026-07-28". `MCP_SDK_GENERATION=v1|v2` forces one;
  `MCP_PROTOCOL_NEGOTIATION=auto|legacy` controls whether Claude Code asks a server about
  the newer revision (`legacy` keeps every server on the older handshake).
* After connect it issues discovery requests (`tools/list`, `prompts/list`,
  `resources/list`) and retries those up to three times on transient errors.
* On `list_changed` in an interactive session it re-fetches the updated list; in
  `-p`/SDK mode it refreshes only the tool list. A failed refresh keeps the previously
  discovered lists.
* Remote servers are reconnected automatically (5 attempts, exponential backoff from 1 s);
  stdio servers are **not** reconnected automatically.
* Tool search is on by default: tool definitions may be withheld from context and loaded on
  demand (`ToolSearch`; `WaitForMcpServers` when tool search is off).

---

## 9. Easy to get wrong

Ordered roughly by how often a from-scratch implementation trips on them.

1. **`notifications/initialized`, not `initialized`.** The notification method carries the
   `notifications/` prefix; the *request* is bare `initialize`. Same for `notifications/cancelled`.
2. **Nothing but MCP messages on stdout.** "The server **MUST NOT** write anything to its
   `stdout` that is not a valid MCP message." One `console.log` (or a banner, or a
   progress bar, or a warning printed by a dependency) corrupts the stream and can hang the
   client. Logs go to `stderr`, and the client must not treat stderr as failure.
3. **Do not implement Content-Length framing.** Every published MCP revision specifies
   newline-delimited JSON for stdio. LSP-style `Content-Length` headers are not in the spec.
4. **A version mismatch is not an error in the legacy era.** The server answers with a
   *different* `protocolVersion` in a normal result; only in 2026-07-28 does it become
   `-32022` with `data.supported`. Don't map `-32022` onto "unknown method" (-32601).
5. **Legacy servers send requests, not just notifications.** `roots/list`,
   `sampling/createMessage`, `elicitation/create`. A client that never answers will hang
   such a server. (Claude Code answers `roots/list` and sends
   `notifications/roots/list_changed`.) In 2026-07-28 this channel is gone entirely and
   replaced by MRTR.
6. **`isError` is inside a successful result.** A failed tool is a JSON-RPC *success* with
   `result.isError === true`. Never convert it to a JSON-RPC error, or the model loses the
   self-correction signal the spec asks you to preserve.
7. **Pagination: absence of `nextCursor`, not an empty string, means the end.** "an empty
   string is a valid cursor and thus **MUST NOT** be treated as the end of results."
8. **`inputSchema` must be an object, never `null`.** For parameter-less tools the spec
   recommends `{"type":"object","additionalProperties":false}`. Default dialect is JSON
   Schema **2020-12** when `$schema` is absent.
9. **Tool names are only unique per server.** If you aggregate servers, prefix them. The
   spec warns explicitly that `serverInfo.name` is not unique and must not be used for
   disambiguation. Claude Code's convention is `mcp__<server>__<tool>` (and
   `mcp__plugin_<plugin>_<server>__<tool>` for plugin servers, with every other character
   replaced by `_`).
10. **`prompts/get` messages are not tool content.** They are
    `{ role, content: { type, … } }` objects with `role` limited to `"user"`/`"assistant"`.
11. **Resource-not-found moved.** `-32602` now; accept `-32002` from older servers. And
    never return an empty `contents` array for a missing resource — the spec forbids it as
    ambiguous.
12. **Notification plumbing changed in 2026-07-28.** `list_changed` notifications require an
    open `subscriptions/listen` stream, the server first sends
    `notifications/subscriptions/acknowledged`, and every notification carries
    `_meta["io.modelcontextprotocol/subscriptionId"]`. `resources/subscribe`, the HTTP GET
    stream, `ping`, `logging/setLevel`, and `notifications/roots/list_changed` are gone;
    `logging`, `roots`, and `sampling` are deprecated.
13. **Requests need non-null, non-colliding ids; notifications must omit `id`.** The spec
    deviates from JSON-RPC here: "the ID **MUST NOT** be `null`", and an id must not
    duplicate an in-flight request. On MRTR retries, "the JSON-RPC `id` **MUST** be
    different between the initial request and the retry."
14. **A silent stdio server after launch is healthy.** `claude mcp serve` "prints nothing
    when it starts". Don't expect a handshake banner, and don't emit one.
15. **HTTP: `Accept: application/json, text/event-stream` is mandatory**, and the client
    must handle *both* response content types per request. In 2026-07-28 the `MCP-Protocol-Version`
    header must match the body's `_meta` value exactly or the server returns `400` +
    `-32020`. In 2025-06-18…2025-11-25, a missing `MCP-Protocol-Version` made servers assume
    `2025-03-26`.
16. **Legacy HTTP sessions are stateful.** `MCP-Session-Id` on every subsequent request;
    `404` means "re-initialize"; `DELETE` to terminate; `Last-Event-ID` resumes a stream.
    None of that exists in 2026-07-28 — a client that replays those behaviours at a modern
    server should expect `405`/ignored headers.
17. **The stdio client must not send responses, and (modern) the server must not send
    requests.** A client that replies to a server *notification* is violating the framing
    contract; a client that can't answer a server *request* breaks legacy servers.
18. **Progress only if requested.** No `progressToken` in `_meta` ⇒ no `notifications/progress`;
    and `progress` must strictly increase. Don't use progress to extend a hard timeout
    (Claude Code explicitly does not).
19. **Claude Code's config has a trap:** a `url` without `type` is read as a stdio entry and
    rejected; `streamable-http` is an accepted alias for `http`; and `${VAR}` in a remote
    `url`/`headers` silently expands to empty for a blocklist of credential-looking names.
20. **Output size is capped by the host.** Claude Code truncates/relocates large tool
    results (25 k tokens / 50 k chars), errors at 16 MiB per HTTP body/SSE event, and
    truncates long `isError` text to its first 5,000 + last 5,000 characters.

---

## 10. Explicit gaps

* The full text of the live `code.claude.com/docs/en/mcp.md` sections after "MCP output
  limits and warnings" — including the current wording for MCP elicitation handling,
  `anthropic/requiresUserInteraction`, `anthropic/maxResultSizeChars`, "Exempt a server
  from deferral" (`alwaysLoad`), and "Configure tool search" — was not retrieved. The
  February 2026 capture covers the resources/prompts/tool-search material; the newer
  sections are known only by their anchors, by the one search snippet showing
  `"anthropic/requiresUserInteraction": true`, and by the `MAX_MCP_OUTPUT_TOKENS` /
  `anthropic/maxResultSizeChars` text that survived in the truncated head.
* `ToolAnnotations` defaults and exact per-field descriptions were not reached on the
  schema page. Only the four names are verified.
* The exact `protocolVersion` string Claude Code's v1 runtime sends in `initialize` is not
  documented on any page I fetched.
* MCP elicitation and sampling request/response schemas were deliberately out of scope and
  were not fetched beyond the mention of `elicitation/create` inside MRTR examples.
