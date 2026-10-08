# June backend: operation and integration

## Architecture

```
Renderer UI (no Node or raw IPC)
       |
       | backendCall(action, data) / onBackendEvent(listener)
       v
Electron main process
       |
       +-- backend/service.cjs -- run state and approvals
       +-- backend/ollama.cjs  -- tags, show, chat stream, embeddings
       +-- backend/workspace.cjs -- registered-root files and commands
       +-- backend/mcp.cjs -- tools-only MCP client
       +-- backend/rag.cjs -- incremental SQLite retrieval index

Optional alternative: backend/server.cjs -- authenticated loopback HTTP/SSE
```

The desktop service starts lazily with Electron. It does not listen on a port or
require Python. The headless server reuses the same service and is an alternative
integration transport, not an extra server the desktop needs to launch.

## Ollama configuration

Start Ollama using its application/service or `ollama serve`. Do not start a second
server when the desktop Ollama application is already listening. `ollama ls`
shows installed models. Use `ollama pull <model-name>` outside June to obtain a
model; replace the placeholder with an actual model from Ollama's library.

In Settings > Ollama:

- Base URL defaults to http://127.0.0.1:11434, without /api or /v1.
- Save & connect validates and saves configuration, then calls /api/tags.
- The composer model selector is populated from that server's installed list.
  Selecting a missing or embedding-only model produces a clear error.
- /api/show supplies capability checks. Chat can continue from supplied context
  without file tools when a model lacks tool support. Plan and Agent require a
  tool-capable model when tools are offered. A narrowly formatted printed
  request for a built-in read-only file tool can be handled as a tool call;
  printed write, terminal, and MCP requests are never executed.
- /api/chat streams NDJSON. Stream failure, malformed output, cancellation and
  incomplete responses are not reported as successful completions.
- Context window, output limit, temperature, model keep-alive, agent-round limit,
  and offering write/terminal tools are configurable. The default context is
  8192 and output cap 2048; larger contexts can require substantially more memory.
- The context budget uses conservative character estimates, not a model-specific
  tokenizer. The configured num_ctx is also sent to Ollama. Old saved history is
  not deleted when June omits older messages from a request.

Remote servers require HTTPS and explicit opt-in. A bearer secret can be read
from a named environment variable; enter only its name in settings, then set its
value before starting June. Provider secrets are not stored in browser storage.
The URL setting controls transport only. A localhost Ollama server can itself
use cloud-backed models, so choosing local weights is necessary for offline use.
June neither controls nor guarantees the server's logging/retention policy.

## Chat, Plan, and Agent

Chat can use local read-only inspection tools when a project is open, then answer
from the results. Without a project, it sends messages and optional retrieved
context without tools. The legacy frontend value `ask` maps to Chat. Plan
offers the same local read-only inspection tools for planning. Agent also offers
list_directory, read_file, and literal search_files for an opened project. It
may offer write_file and run_command when explicitly enabled.

For repository overview questions in Chat, June also reads the root README and
first recognized project manifest (when present) into the initial context. This
works without an RAG index and avoids relying on a small model to request its
first file correctly. The files remain subject to project path and credential
exclusions.

Some local models print a JSON-shaped read-tool request in the reply instead of
emitting Ollama `tool_calls`. June accepts only a complete, valid request for
`list_directory`, `read_file`, or `search_files` in that form. It clears the
provisional text from the displayed answer and passes the result back to the
model. Other printed tool requests remain plain text.

Every file edit requires a SHA from read_file (or `new` for a new file), a complete
replacement, and user approval of the exact proposal. Only existing parent
folders are supported; there is no mkdir/delete/stage/commit tool. Files are
rechecked after approval. Existing files use an atomic replacement; new files
use exclusive creation. This protects against normal concurrent edits, but is
not a complete defense against malicious, rapidly changing filesystem races.

Every run_command request requires approval, executable + separate argument
array, a registered-project working directory, and uses shell:false. .cmd/.bat
wrappers are rejected. Windows users can explicitly approve a powershell.exe
or node.exe command when a workflow needs it. Commands get a minimal environment,
a 60-second timeout, bounded output, and process termination on cancellation.
They still run with your user permissions, not inside a filesystem/network
sandbox. Do not interpret the working-directory restriction as containment.

One generation or index job runs at a time. Settings/connections cannot change
mid-run. Default maximum is eight model/tool rounds, with a 24-tool-call ceiling.
Approval requests expire after five minutes and belong to their originating
window/run. Closing the window or pressing Stop aborts pending requests. A tool
that already completed before cancellation is not rolled back.

## MCP server setup

Settings > MCP servers supports two transports.

### stdio

Use an actual executable, for example:

```
Name: My tools
Executable: C:\Program Files\nodejs\node.exe
Arguments (JSON): ["C:\\Tools\\my-mcp-server\\server.mjs"]
Environment variable names: MY_SERVICE_TOKEN
```

Paths are examples, not software that June installs. The executable must already
exist. Avoid npx.cmd and .bat wrappers; install the chosen server yourself and
point Node/Python at its real entry point. Only requested environment variable
names and the small platform/PATH baseline are forwarded. NODE_OPTIONS and
ELECTRON_RUN_AS_NODE are not implicitly forwarded. The server starts in the user
home directory; workspace roots are not silently granted. Put required root
arguments in the server configuration and inspect them before connecting.

The native Connect dialog shows the actual executable and arguments. A server
process can access data with your account's privileges before any tools execute;
tool approval is not a sandbox for the server program. Trust the installed code.

### Streamable HTTP

Use the MCP endpoint, e.g. http://127.0.0.1:3000/mcp. A remote endpoint requires
HTTPS and the explicit remote checkbox. A bearer-token environment-variable name
can be set for servers that accept token authentication. OAuth browser sign-in
is not implemented; connecting an OAuth-only server will require future work.

### Tool permissions and scope

After connecting, June initializes the session, lists tools, and displays their
names/descriptions. No tool is enabled automatically. Check the tools needed by
the coding agent. Agent requests use stable namespaced tool names. Every call
shows its exact arguments and requires Approve once, including tools advertised
as read-only by the server. Denial becomes a tool result; June does not execute
the action anyway. MCP results are untrusted model context and are bounded.

Connections remain active for the running app until disconnect/quit, but are not
automatically connected on the next launch. Temporary sessions never offer MCP
tools to the model. Stop sends cancellation where supported; external servers
may already have completed an action and cannot be forced to undo it.

This is a custom, bounded **tools-only** client for negotiated protocol versions
2025-11-25, 2025-06-18 or 2025-03-26. It implements initialize/initialized,
tools/list pagination, tools/call, stdio JSONL, Streamable HTTP JSON/SSE responses,
session/protocol headers, session deletion and bounded cancellation. It is not
advertised as a complete SDK or protocol certification. Resources, prompts,
sampling, elicitation, OAuth, legacy HTTP+SSE transports, server-to-client tool
list notifications and SSE resumption are not implemented. Reconnect to refresh
a changed server's tool catalog. Side-effecting calls are never auto-retried.

## Project RAG

Keyword retrieval works without an embedding model. Hybrid mode calls Ollama's
/api/embed for source chunks and the search query, then combines lexical ranking
with vector similarity. The installed embedding model is separate from the chat
model. June never silently downloads an embedding model or falls back from a
broken hybrid index to fabricated context.

Open a project, save RAG mode/settings, and click Index / update project. A
confirmation explains local storage and possible remote embedding transmission.
Indexing reads supported UTF-8 source/code/text files, with a 512 KB file limit.
PDFs, images and general binary document ingestion are not supported. Chunks are
line-aware (roughly 45 lines / 1800 characters with overlap), preserve source line
references, and omit long minified lines. Default caps are 1500 files, 5000
chunks and 5 returned chunks. Limits and progress are visible; processing is
bounded rather than a claim that every file of a large repository was indexed.

Git projects use git ls-files with --exclude-standard to honor ignore rules.
Common generated folders, lockfiles, credential filenames, symlinks, hard links
and unsupported/binary files are excluded. A non-Git project uses bounded
filesystem traversal. These filters are not DLP: secrets in ordinary source
files may still be indexed. Review your project before granting access.

SQLite stores unencrypted source chunks, content hashes, line ranges, index
metadata and optional float-vector BLOBs in <userData>/retrieval/rag.sqlite.
Unchanged files reuse stored chunks/vectors. Deleted files are pruned on update;
failed or cancelled rebuilds preserve the last completed index. Changing the
embedding model, its digest or endpoint requires reindexing. Before retrieval,
June re-reads candidate files and rejects stale hashes instead of citing stale
content. Manually update after edits; no file watcher is installed.

Clear index removes the active project's index entries, not its source files.
SQLite pages, WAL files, backups or filesystem snapshots may retain historical
bytes; it is not a secure-erasure promise. Chat messages and memory-library
entries are not added to this project index.

Source chips show the retrieved passages used to construct the request, not a
claim that the model correctly relied on every passage. Selecting a chip opens
the source file; jump-to-line/editor integration remains separate work.

## Memory, skill and temporary behavior

The existing approved/enabled, global/project-scoped Memories & skills selections
now flow through requestContext into the real request. The backend validates and
bounds them again. Automatic memory extraction, skill audits/confidence scoring
and automatic threshold-based context summarization are still not implemented.
Compact context can generate a draft on demand using the saved instructions in
Settings > General. The draft is not applied until the user reviews and saves it.
Reviewed summaries are sent as user-reviewed context, not arbitrary system
instructions.

Temporary chats remain in renderer memory. June does not persist their prompts,
replies, drafts or run logs, and excludes memories, skills, RAG and MCP. Normal
chats persist their streamed replies and source/activity metadata locally. The
backend does not persist raw model or tool payload logs in either mode.

Temporary mode does not prevent explicit file edits/commands you approve, model
server logging, external exports/clipboard copies, OS swap/crash dumps, or cloud
model delegation by Ollama. It is local application privacy, not anonymity.

## Optional headless API

Do not run this for normal desktop use. It is useful for integrating a custom
pipeline/client and uses a separate default data directory (~/.june-backend).
Do not share one data profile between independently running service instances.

PowerShell example:

```powershell
$env:JUNE_API_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:JUNE_DATA_DIR = "$env:LOCALAPPDATA\June-headless"
npm run backend -- --project "C:\Development\June"
```

JUNE_PORT defaults to 8765. The listener binds only 127.0.0.1. /health returns only
service health, not model availability. All operations require Authorization:
Bearer <JUNE_API_TOKEN> (at least 32 random characters). The token grants
privileged local configuration/agent capabilities. Keep it secret and never
expose the listener through a public reverse proxy. Requests with Origin headers
or an unexpected Host are rejected; there is no browser CORS bypass.

- POST /api/invoke accepts {"action":"...","data":{...}} and returns JSON.
- POST /api/stream accepts run.start or rag.index and returns SSE `data:` events.
- Desktop uses the same actions via preload, not these HTTP URLs.

Actions: state, config.update, models, model.info, rag.status, rag.clear,
rag.index, mcp.connect, mcp.disconnect, run.start, job.cancel, run.approve.
For the headless API, the authenticated caller is the trusted operator: there is
no native MCP Connect dialog, but per-tool approval events are still mandatory.

Minimal streaming request body (replace the project path/model):

```json
{
  "action": "run.start",
  "data": {
    "id": "run-001",
    "model": "your-installed-model",
    "mode": "chat",
    "projectPath": "C:\\Development\\June",
    "messages": [{"role":"user","content":"Explain the authentication code."}],
    "useRag": true,
    "temporary": false
  }
}
```

A project must be registered through the desktop picker or the headless --project
startup argument. Passing a path in a request does not authorize it. Events
include started, status, token, thinking (status only), sources, context,
warning, tool_start, approval_required, tool_done, file_written, metrics, done,
error and cancelled. Supply the exact run ID and approval ID in run.approve with
an explicit approved boolean. Disconnected SSE clients cancel their active jobs.

## Primary protocol references

- Ollama chat: https://docs.ollama.com/api/chat
- Ollama installed models: https://docs.ollama.com/api/tags
- Ollama embedding API: https://docs.ollama.com/api/embed
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Node built-in SQLite: https://nodejs.org/api/sqlite.html

Protocol support is limited to what is implemented and tested above; the code is
not a security audit or an LLM quality benchmark.
