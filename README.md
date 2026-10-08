# June

A project-aware desktop coding workspace with an Ollama backend, streamed chat,
approval-gated agent tools, MCP tool servers, and local project retrieval.

This update is based on `BigJMC9/June` main at
`fd964ba48d07cf70e405e4805d02b42cb5cb5cca`. It is a source update, not a signed
installer. See [INSTALL.md](INSTALL.md) before copying it over a checkout.

## Start

Use Node.js 22.16+ for development, tests, and the optional headless server.
Packaged desktop builds use the Node runtime embedded in Electron. Existing
Electron and builder dependencies are unchanged; no new npm dependency is added.

```sh
npm install
npm run dev
```

Start Ollama separately, then open **Settings > Ollama**, use the default base URL
`http://127.0.0.1:11434`, and select **Save & connect**. Alternatively, enable
**Let June start Ollama** in **Settings > Performance** to manage a local Ollama
process. Choose an installed model in the composer. June lists models; it does
not download one automatically.

The normal desktop backend starts with the app and communicates through the
sandboxed preload bridge. **No Python service or listening HTTP port is needed**
for the desktop app. Ollama is the separate model server.

## Performance profiles

**Settings > Performance** holds named profiles for the context window, output
limit, temperature, model keep-alive, CPU/GPU mode, CPU threads, batch size,
main GPU, and memory mapping. The active profile applies to chat, summaries,
and embeddings. CPU only requests `num_gpu: 0`; GPU + CPU lets Ollama choose;
GPU only requests full offload and checks `/api/ps` before a chat response. A
model that does not fit entirely in GPU memory produces a clear error.

Vulkan and Flash Attention are Ollama server startup settings. June applies
them when **Let June start Ollama** is enabled and restarts only the Ollama
process it owns when these settings change. An already running external Ollama
server must be configured and restarted outside June. Managed Ollama requires
a local `127.0.0.1` URL and an `ollama` executable on `PATH`. **Ollama
diagnostics** shows startup settings, process output, failures, and the log
path in June's user-data directory. The log can contain machine details and
Ollama output; inspect it before sharing.

If Ollama returns a runner error, June shows any specific cause found in its
recent diagnostic output and adds **View Ollama diagnostics** beside the failed
reply. The diagnostics panel is also under **Settings > Performance**. On
Windows, Ollama's own server log is at `%LOCALAPPDATA%\Ollama\server.log`.
If a `main_gpu` error says one device is available, clear **Main GPU index**
in the profile and save it; the field is zero based within Ollama's selected
GPU backend.

## Interaction modes

| Mode | Behavior |
| --- | --- |
| Chat | Streams replies and can inspect an open project with read-only file tools. Repository overview questions include the root README and project manifest when available. Optional RAG can add more context. |
| Plan | Read-only project inspection and planning. No edits, terminal, or MCP tools. |
| Agent | Project listing, file reading and literal search. File edits and terminal tools can be enabled in Settings; each edit or command needs approval. Enabled MCP tools always need approval too. |

Models that explicitly lack Ollama tool capabilities can still answer in Chat
from supplied context, but cannot inspect additional files on demand. Plan and
Agent require tool support when tools are offered. Stop cancels the active
request; partial normal-chat replies remain marked as stopped.

## Workspace features

- One collapsible sidebar with project selection and project-scoped chats/search.
- Native folder selection; lazy file browsing; read-only previews; Git status.
- Per-chat model/mode selection; streamed replies and timing/token metrics.
- Reviewed write proposals with a before/after view and stale-file checks.
- Local Memories & skills library and reviewed imports; approved relevant-scope
  entries can now be included in actual requests.
- Cookbook model/cache discovery and command preparation. It still does not
  automatically install, download, or launch models.
- Temporary chats: no June chat/draft persistence; no memories, skills, RAG, or
  MCP context. This does not control provider retention or OS memory/swap.
- Existing Markdown/PDF exports and reviewed context summaries remain. **Settings > Agents**
  lets you create agent profiles with system prompts, instructions, and condensation
  instructions. Choose a profile in the composer. Optional project and chat overrides
  take priority over profile defaults. Set the condensation trigger percentage, summary
  output budget, and recent turns to preserve there; 0% disables automatic condensation.
  Compact context can also generate a draft
  with Ollama for review before it changes future requests.
  Older messages condensed out of the active context can be searched and read by the
  agent when it needs details absent from the summary. Conversation retrieval is
  scoped to the current chat. Enable **Include matches with project RAG** in an
  agent profile or override to add relevant older message excerpts alongside
  project retrieval results when project RAG is active.
- The composer shows an estimated input-context token bar with the active agent's
  condensation threshold. Responses show a live elapsed clock and save the total
  wall time beside token count and generation speed. Chat messages render headings,
  lists, emphasis, and code blocks from Markdown as text-safe elements.

## MCP

**Settings > MCP servers** supports explicitly connected stdio processes and
Streamable HTTP tool endpoints. Configure a server, connect it, then enable the
specific discovered tools that the agent may request. Every invocation is shown
for approval. Connections are not automatically restarted when June launches.

This is a bounded tools-only MCP client for the 2025-11-25, 2025-06-18, and
2025-03-26 protocol versions, not the entire MCP surface. OAuth, resources,
prompts, sampling, elicitation, legacy HTTP+SSE, and stream resumption are not
implemented. See [docs/BACKEND.md](docs/BACKEND.md) for configuration and limits.

## Project RAG

**Settings > Project RAG** offers keyword retrieval without an embedding model,
or hybrid keyword/vector retrieval using an installed Ollama embedding model.
Choose a project, save retrieval settings, and **Index / update project**.
Responses show the retrieved file/line references; use the composer's RAG control
to omit retrieval for a request.

The incremental SQLite index stores source snippets and optional embeddings
locally. It respects Git ignore rules, excludes common generated folders,
credential filenames, links, binaries, large files and unsupported formats, and
checks content hashes before returning a result. Changing source files or the
embedding model requires reindexing. Indexing is manual, not a file watcher.

## Safety and limitations

File reads/writes are restricted to registered project roots with traversal,
link, and credential-path checks. Writes are off by default and never auto-apply.
Approved commands and MCP server programs **are not an OS sandbox**: they run
with your user permissions and can access other files or networks. Use trusted
servers, inspect proposed commands, and keep separate backups/version control.

Local settings, chats, and indexes are not encrypted. Credential filenames are
not a secret scanner. An Ollama endpoint on localhost can still delegate cloud
models; use local model weights for offline inference. Temporary mode is not
anonymity, secure deletion, or a promise about external server logging.

## Tests and build

```sh
npm test
npm run test:backend
npm run build:win
```

The test suite uses deterministic Ollama/MCP protocol fixtures, not a live LLM.
[VALIDATION.md](VALIDATION.md) records the exact checks and native testing limits.
The optional authenticated loopback server is documented in
[docs/BACKEND.md](docs/BACKEND.md); normal desktop use does not require it.
