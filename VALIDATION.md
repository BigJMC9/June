# Validation: Ollama / Agent / MCP / RAG

## Source baseline

Built against BigJMC9/June main at
`fd964ba48d07cf70e405e4805d02b42cb5cb5cca`, verified through the connected GitHub
API. The preceding workspace-tools source archive matched those repository code
blobs before modification. The repository head was rechecked before packaging.

This source archive contains the implementation. It does not, by itself, mean a
commit or branch was pushed to GitHub.

## Executed checks

| Suite | Result | What ran |
| --- | --- | --- |
| `npm test` | 69 passed, 0 failed, 0 skipped | Node service, original workspace-data/export helpers, actual temporary files, built-in SQLite, HTTP protocol fixtures, stdio MCP child process, and optional HTTP server. |
| `JUNE_OFFLINE_TEST=1 python tests/ui_smoke.py` | 61 passed | Existing renderer regression checks, updated for the new backend/settings controls and safe unavailable-bridge state. |
| `python tests/features_ui.py` | 49 passed | Existing Memories/Skills/Cookbook/temporary-session regression checks. |
| `python tests/backend_ui.py` | 21 passed | The renderer calling the real Node backend through a test bridge, with fixture Ollama and MCP servers. |

Total: **200 passing checks**, across four suites. All source JS/CJS/MJS files
were also syntax-checked with Node. Machine-readable results and the Node TAP
output are in `validation/`.

## Backend coverage

- Streaming NDJSON with split UTF-8 bytes, bad JSON, incomplete responses,
  explicit Ollama errors, model capabilities and embedding responses.
- Chat tool denial, Plan read-only access, Agent execution and step limits.
- Approval required before actual fixture file creation/replacement; denial,
  cancellation, run ownership, expiry and changed-file SHA checks.
- Traversal, unauthorized roots, symlinks, hard links, sensitive filenames,
  UTF-8/binary and size restrictions, plus NUL-delimited Git status parsing.
- Project-isolated RAG, ignored/unsupported files, keyword/hybrid retrieval,
  incremental vector reuse, deleted/stale files, embedding-model/digest changes,
  index cancellation, and temporary-session exclusions.
- Actual stdio MCP fixture process and Streamable HTTP JSON/SSE fixtures,
  initialization/session headers, tools, allowlists, approvals and minimal env.
- Optional loopback API authentication, Host/Origin checks and real command
  argument handling without an implicit shell.

## End-to-end renderer coverage

The 21 added checks exercise a real Node backend (not a stub of the service):
model selection, default Chat mode, streamed assistant text, saved normal
responses, metrics, Stop, active-run navigation guards, saved write permissions,
visible tool approval before a real temporary file is written, real project
indexing, source chips, temporary-chat storage exclusion, MCP discovery and
enabling, and approved MCP execution. No browser script errors were observed.

## Environment and qualifications

Executed using Node 22.16.0, built-in node:sqlite, Python 3.13, Playwright, Chromium
and Linux temporary directories. Node prints its experimental SQLite warning in
this runtime. No new npm package was installed or required for the backend.

Chromium network navigation was blocked by this environment's administrator
policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). Renderer tests therefore use the existing
about:blank/offline loader with in-memory module concatenation, simulated storage
and a simulated preload bridge. In the added integration suite, bridge calls are
forwarded to the actual local Node service, which talks to actual loopback test
servers. These checks do not validate native ES-module loading, Electron IPC,
CSP enforcement, OS window controls or platform dialogs.

**Ollama model inference was not run.** The Ollama fixture implements deterministic
protocol responses and embeddings; it is neither a real downloaded model nor a
coding-quality benchmark. A real stdio/HTTP MCP fixture was exercised, but broad
third-party-server or complete MCP specification conformance was not certified.
No Electron binary, signed installer, native Windows execution, native PDF export,
real model GPU/RAM performance, real remote service, or OAuth flow was tested.
The screenshots use the fixture models `test-coder` / `test-embed` and a disposable
test project, not a claim about installed models on the user's computer.

## Required local smoke test

1. Install dependencies and restart Electron, including the new main/start and
   preload files. Confirm the window and menus still load without console errors.
2. Connect the actual Ollama service and an installed completion model. Send a
   short Chat message; test Stop on a long reply and a missing-model error.
3. In a disposable Git project, ask a tool-capable model to read and edit one
   file. Verify that Deny leaves it unchanged and Approve once writes the reviewed
   proposal. Edit the file externally while approval is pending and verify refusal.
4. Index a small real project in keyword mode and then with a real embedding
   model. Confirm line references, excluded files, reindexing and clearing.
5. Connect a trusted real MCP server, enable one low-risk tool, and test both
   approval and denial. Confirm the server disconnects on application quit.
6. Send a temporary message and confirm that closing/reloading June does not
   restore it. Remember that Ollama or remote servers may still log requests.

No test result is a security-audit, sandbox, secure-erasure or model-quality
claim. Retain backups/version control and use disposable projects first.
