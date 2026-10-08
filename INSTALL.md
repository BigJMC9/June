# Install the Ollama / Agent / MCP / RAG update

Base: BigJMC9/June main at fd964ba48d07cf70e405e4805d02b42cb5cb5cca.
This is an overlay for an existing checkout, not an installer or a full Git clone.
It does not change your Ollama installation or download any model weights.

1. Back up or commit local source changes. Fully close June, including its
   background Electron process.
2. Copy the contents of this archive to the repository root, merging directories
   and replacing the files included in the archive.
3. IMPORTANT: replace `electron/main.cjs` in this update as well. Earlier update
   instructions said to retain it; those instructions no longer apply.
4. Retain your existing `LICENSE`, `package-lock.json`, `.git` and `node_modules`.
   They are deliberately not included here. No dependency version changed.
5. Use Node 22.16+ (check `node --version`). Run `npm install` to reconcile package
   metadata if necessary, then `npm run dev`.
6. Start Ollama separately if it is not already running. Use Settings > Ollama >
   Save & connect with `http://127.0.0.1:11434`. Pick an installed model in the
   composer. If the list is empty, pull a model in Ollama and refresh the list.

Changing only app.js/index.html is not enough: the new `backend/` directory,
`electron/backend.cjs`, main/start/preload changes, UI modules and package file
must all be present. A browser refresh does not load a new Electron preload.

## First checks

- Chat: choose an installed completion model, type a question, and watch its
  streamed reply. Test Stop with a longer response.
- Agent: open a project and choose a tool-capable model. Ask it to inspect files.
  For edits, enable Offer file-edit tools in Settings > Ollama > Agent permissions,
  save, and review the explicit proposal. Nothing should change before approval.
- RAG: open Settings > Project RAG, save Keyword retrieval and Use RAG, then index
  the active project. Ask about a file and inspect the source references.
- Hybrid RAG: separately pull an embedding model in Ollama, refresh models, select
  it in RAG settings, save, and reindex. No embedding model is downloaded by June.
- MCP: add a trusted server, connect, select permitted tools, then ask the Agent
  to use one. Both server launch and tool invocation should require consent.
- Temporary: start a temporary chat, send a message, end the session, and confirm
  it is absent from saved history. RAG and MCP should be unavailable in that mode.

## Data compatibility

The existing projects.json registry, normal chats, settings, Memories & skills,
and Cookbook configurations are retained. The backend adds backend-settings.json
and retrieval/rag.sqlite under Electron's userData directory (normally the June
application-data directory). The new Ollama settings are separate from the old
placeholder backend URL. This deliberately avoids treating an old arbitrary
endpoint as permission to send code or launch tools.

The source update does not delete existing chats, project files or indexes. Do
not copy test fixtures into real project folders or import the test credentials.
