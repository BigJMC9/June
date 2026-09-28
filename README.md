# June UI Prototype

A lightweight Odysseus-inspired frontend shell for an AI coding workspace.

## Included

- Project switcher with persistent active project
- New chat and search / command palette
- Chat session list
- Project / repository / branch context
- Conversation-first AI workspace
- Agent activity cards
- Coding composer with Agent mode
- Changes / Files / Runs workbench
- Responsive sidebar behavior
- Keyboard shortcuts: `Ctrl/Cmd+K`, `Ctrl/Cmd+N`, `Esc`

## Run

Open `index.html` directly, or serve the directory with any static server.

Example:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Backend integration seams

The frontend is intentionally framework-light. Replace the placeholder send flow in `app.js` with your agent backend:

- `POST /api/chats`
- `POST /api/runs`
- SSE/WebSocket stream for agent events
- `GET /api/projects`
- `GET /api/projects/:id/files`
- `GET /api/runs/:id/changes`
- patch approval / apply endpoints

The current UI already separates project context, chat state, file changes, and run status, so those can be wired without changing the layout model.


## Desktop integration

The Electron shell currently provides:

- Native application window
- Single-instance behavior
- Secure context-isolated preload bridge
- Native project-folder picker
- External HTTP/HTTPS links opening in the system browser
- Windows NSIS packaging
- macOS DMG/ZIP packaging
- Linux AppImage packaging

The renderer does not receive direct Node.js, filesystem, shell, or child-process access. Add privileged desktop capabilities as explicit IPC methods as the local agent/backend is implemented.


## Functional desktop workspace

The `desktop-electron` branch now uses real local project data rather than prototype placeholders.

Available now:

- Add local projects with the native folder picker
- Persist authorised projects in Electron user data
- Restore the last active project
- Browse real project directories with lazy folder expansion
- Hide/show dotfiles and common generated directories
- Preview UTF-8 text files with a configurable size limit
- Detect binary/oversized files without loading them into the renderer
- Search project file and folder names
- Reveal projects/files in the operating system
- Read the current Git branch and uncommitted `git status`
- Persist local chat sessions
- Persist appearance, workspace, agent, and safety settings
- Test the configured agent backend via `GET /health`
- Theme and density settings that apply immediately

### Security boundary

All project paths must first be authorised through June's native project picker. The renderer cannot supply arbitrary filesystem paths: main-process IPC resolves requested paths beneath an authorised project root and rejects traversal outside it.

The renderer remains sandboxed with `nodeIntegration: false` and `contextIsolation: true`. Filesystem, Git, OS reveal, and backend-health operations are exposed as narrow preload APIs.

### Still waiting on the custom pipeline backend

The UI intentionally does not fake these capabilities:

- Model/agent response streaming
- Agent file writes and patch application
- Terminal command execution
- Agent run history
- Tool execution
- Context assembly/model routing

The settings and UI surfaces for those features are present so the backend can be connected without redesigning the frontend.
